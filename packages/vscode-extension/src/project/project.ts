import { EventEmitter } from "stream";
import { Disposable, commands, workspace, window, DebugSessionCustomEvent } from "vscode";
import stripAnsi from "strip-ansi";
import { minimatch } from "minimatch";
import { isEqual } from "lodash";
import {
  AppPermissionType,
  DeviceSettings,
  InspectData,
  ProjectEventListener,
  ProjectEventMap,
  ProjectInterface,
  ProjectState,
  RecordingData,
  ReloadAction,
  StartupMessage,
  TouchPoint,
  ZoomLevelType,
} from "../common/Project";
import { Logger } from "../Logger";
import { DeviceInfo } from "../common/DeviceManager";
import { DeviceAlreadyUsedError, DeviceManager } from "../devices/DeviceManager";
import { extensionContext } from "../utilities/extensionContext";
import { IosSimulatorDevice } from "../devices/IosSimulatorDevice";
import { AndroidEmulatorDevice } from "../devices/AndroidEmulatorDevice";
import { DependencyManager } from "../dependency/DependencyManager";
import { throttle, throttleAsync } from "../utilities/throttle";
import { DebugSessionDelegate } from "../debugging/DebugSession";
import { Metro, MetroDelegate } from "./metro";
import { Devtools } from "./devtools";
import { AppEvent, DeviceSession, EventDelegate } from "./deviceSession";
import { PlatformBuildCache } from "../builders/PlatformBuildCache";
import { PanelLocation } from "../common/WorkspaceConfig";

const DEVICE_SETTINGS_KEY = "device_settings_v4";
const LAST_SELECTED_DEVICE_KEY = "last_selected_device";
const PREVIEW_ZOOM_KEY = "preview_zoom";
const DEEP_LINKS_HISTORY_KEY = "deep_links_history";

const DEEP_LINKS_HISTORY_LIMIT = 50;

export class Project
  implements Disposable, MetroDelegate, EventDelegate, DebugSessionDelegate, ProjectInterface
{
  public static currentProject: Project | undefined;

  private metro: Metro;
  private devtools = new Devtools();
  private eventEmitter = new EventEmitter();

  private isCachedBuildStale: boolean;

  private fileWatcher: Disposable;

  private deviceSession: DeviceSession | undefined;

  private projectState: ProjectState = {
    status: "starting",
    previewURL: undefined,
    previewZoom: extensionContext.workspaceState.get(PREVIEW_ZOOM_KEY),
    selectedDevice: undefined,
  };

  private deviceSettings: DeviceSettings;

  constructor(
    private readonly deviceManager: DeviceManager,
    private readonly dependencyManager: DependencyManager
  ) {
    Project.currentProject = this;
    this.deviceSettings = extensionContext.workspaceState.get(DEVICE_SETTINGS_KEY) ?? {
      appearance: "dark",
      contentSize: "normal",
      location: {
        latitude: 50.048653,
        longitude: 19.965474,
        isDisabled: false,
      },
      hasEnrolledBiometrics: false,
      locale: "en_US",
      replaysEnabled: false,
      showTouches: false,
    };
    this.devtools = new Devtools();
    this.metro = new Metro(this.devtools, this);
    this.start(false, false);
    this.trySelectingInitialDevice();
    this.deviceManager.addListener("deviceRemoved", this.removeDeviceListener);
    this.isCachedBuildStale = false;

    this.fileWatcher = watchProjectFiles(() => {
      this.checkIfNativeChanged();
    });
  }

  //#region Build progress
  onBuildProgress = (stageProgress: number): void => {
    this.reportStageProgress(stageProgress, StartupMessage.Building);
  };

  onBuildSuccess = (): void => {
    // reset fingerprint change flag when build finishes successfully
    this.isCachedBuildStale = false;
  };

  onStateChange = (state: StartupMessage): void => {
    this.updateProjectStateForDevice(this.projectState.selectedDevice!, { startupMessage: state });
  };
  //#endregion

  //#region App events
  onAppEvent = <E extends keyof AppEvent, P = AppEvent[E]>(event: E, payload: P): void => {
    switch (event) {
      case "navigationChanged":
        this.eventEmitter.emit("navigationChanged", payload);
        break;
      case "fastRefreshStarted":
        this.updateProjectState({ status: "refreshing" });
        break;
      case "fastRefreshComplete":
        const ignoredEvents = ["starting", "incrementalBundleError", "runtimeError"];
        if (ignoredEvents.includes(this.projectState.status)) {
          return;
        }
        this.updateProjectState({ status: "running" });
        break;
    }
  };
  //#endregion

  //#region Debugger events
  onConsoleLog(event: DebugSessionCustomEvent) {
    this.eventEmitter.emit("log", event.body);
  }

  onDebuggerPaused(event: DebugSessionCustomEvent) {
    if (event.body?.reason === "exception") {
      // if we know that incremental bundle error happened, we don't want to change the status
      if (this.projectState.status === "incrementalBundleError") {
        return;
      }
      this.updateProjectState({ status: "runtimeError" });
    } else {
      this.updateProjectState({ status: "debuggerPaused" });
    }

    // we don't want to focus on debug side panel if it means hiding Radon IDE
    const panelLocation = workspace
      .getConfiguration("RadonIDE")
      .get<PanelLocation>("panelLocation");

    if (panelLocation === "tab") {
      commands.executeCommand("workbench.view.debug");
    }
  }

  onDebuggerResumed() {
    this.updateProjectState({ status: "running" });
  }
  //#endregion

  async captureReplay(): Promise<RecordingData> {
    if (!this.deviceSession) {
      throw new Error("No device session available");
    }
    return this.deviceSession.captureReplay();
  }

  async dispatchPaste(text: string) {
    await this.deviceSession?.sendPaste(text);
  }

  onBundleError(): void {
    this.updateProjectState({ status: "bundleError" });
  }

  onIncrementalBundleError(message: string, _errorModulePath: string): void {
    Logger.error(stripAnsi(message));
    // if bundle build failed, we don't want to change the status
    // incrementalBundleError status should be set only when bundleError status is not set
    if (this.projectState.status === "bundleError") {
      return;
    }
    this.updateProjectState({ status: "incrementalBundleError" });
  }

  /**
   * This method tried to select the last selected device from devices list.
   * If the device list is empty, we wait until we can select a device.
   */
  private async trySelectingInitialDevice() {
    const selectInitialDevice = async (devices: DeviceInfo[]) => {
      // we try to pick the last selected device that we saved in the persistent state, otherwise
      // we take the first device from the list
      const lastDeviceId = extensionContext.workspaceState.get<string | undefined>(
        LAST_SELECTED_DEVICE_KEY
      );
      const device = devices.find(({ id }) => id === lastDeviceId) ?? devices.at(0);

      if (device) {
        // if we found a device on the devices list, we try to select it
        const isDeviceSelected = await this.selectDevice(device);
        if (isDeviceSelected) {
          return true;
        }
      }

      // if device selection wasn't successful we will retry it later on when devicesChange
      // event is emitted (i.e. when user create a new device). We also make sure that the
      // device selection is cleared in the project state:
      this.updateProjectState({
        selectedDevice: undefined,
      });
      // when we reach this place, it means there's no device that we can select, we
      // wait for the new device to be added to the list:
      const listener = async (newDevices: DeviceInfo[]) => {
        this.deviceManager.removeListener("devicesChanged", listener);
        if (this.projectState.selectedDevice) {
          // device was selected in the meantime, we don't need to do anything
          return;
        } else if (isEqual(newDevices, devices)) {
          // list is the same, we register listener to wait for the next change
          this.deviceManager.addListener("devicesChanged", listener);
        } else {
          selectInitialDevice(newDevices);
        }
      };

      // we trigger initial listener call with the most up to date list of devices
      listener(await this.deviceManager.listAllDevices());

      return false;
    };

    const devices = await this.deviceManager.listAllDevices();
    await selectInitialDevice(devices);
  }

  async getProjectState(): Promise<ProjectState> {
    return this.projectState;
  }

  async addListener<K extends keyof ProjectEventMap>(
    eventType: K,
    listener: ProjectEventListener<ProjectEventMap[K]>
  ) {
    this.eventEmitter.addListener(eventType, listener);
  }
  async removeListener<K extends keyof ProjectEventMap>(
    eventType: K,
    listener: ProjectEventListener<ProjectEventMap[K]>
  ) {
    this.eventEmitter.removeListener(eventType, listener);
  }

  public dispose() {
    this.deviceSession?.dispose();
    this.metro?.dispose();
    this.devtools?.dispose();
    this.deviceManager.removeListener("deviceRemoved", this.removeDeviceListener);
    this.fileWatcher.dispose();
  }

  private async reloadMetro() {
    if (await this.deviceSession?.perform("reloadJs")) {
      this.updateProjectState({ status: "running" });
      return true;
    }
    return false;
  }

  public async goHome(homeUrl: string) {
    if (await this.dependencyManager.checkProjectUsesExpoRouter()) {
      await this.openNavigation(homeUrl);
    } else {
      await this.reloadMetro();
    }
  }

  //#region Session lifecycle
  public async restart(
    clean: "all" | "metro" | false,
    onlyReloadJSWhenPossible: boolean = true,
    restartDevice: boolean = false
  ) {
    // we save device info and device session at the start such that we can
    // check if they weren't updated in the meantime while we await for restart
    // procedures
    const deviceInfo = this.projectState.selectedDevice!;
    const deviceSession = this.deviceSession;

    this.updateProjectStateForDevice(deviceInfo, {
      status: "starting",
      startupMessage: StartupMessage.Restarting,
    });

    // we first consider forceCleanBuild flag, if set we always perform a clean
    // start of the project and select the device
    if (clean) {
      await this.start(true, true);
      await this.selectDevice(deviceInfo, clean === "all");
      return;
    }

    // Otherwise, depending on the project state we try deviceSelection, or
    // only relad JS if possible.
    try {
      if (restartDevice || this.isCachedBuildStale) {
        await this.selectDevice(deviceInfo, false);
        return;
      }

      if (onlyReloadJSWhenPossible) {
        // if reloading JS is possible, we try to do it first and exit in case of success
        // otherwise we continue to restart using more invasive methods
        if (await this.reloadMetro()) {
          return;
        }
      }

      // we first check if the device session hasn't changed in the meantime
      if (deviceSession === this.deviceSession) {
        await this.deviceSession?.perform("restartProcess");
        this.updateProjectStateForDevice(deviceInfo, {
          status: "running",
        });
      }
    } catch (e) {
      // finally in case of any errors, the last resort is performing project
      // restart and device selection (we still avoid forcing clean builds, and
      // only do clean build when explicitly requested).
      // before doing anything, we check if the device hasn't been updated in the meantime
      // which might have initiated a new session anyway
      if (deviceInfo === this.projectState.selectedDevice) {
        await this.start(true, false);
        await this.selectDevice(deviceInfo, false);
      }
    }
  }

  public async reload(type: ReloadAction): Promise<boolean> {
    this.updateProjectState({ status: "starting" });
    const success = (await this.deviceSession?.perform(type)) ?? false;
    if (success) {
      this.updateProjectState({ status: "running" });
    } else {
      window.showErrorMessage("Failed to reload, you may try another reload option.", "Dismiss");
    }
    return success;
  }

  private async start(restart: boolean, resetMetroCache: boolean) {
    if (restart) {
      const oldDevtools = this.devtools;
      const oldMetro = this.metro;
      this.devtools = new Devtools();
      this.metro = new Metro(this.devtools, this);
      oldDevtools.dispose();
      oldMetro.dispose();
    }

    const waitForNodeModules = this.maybeInstallNodeModules();

    Logger.debug(`Launching devtools`);
    this.devtools.start();

    Logger.debug(`Launching metro`);
    this.metro.start(
      resetMetroCache,
      throttle((stageProgress: number) => {
        this.reportStageProgress(stageProgress, StartupMessage.WaitingForAppToLoad);
      }, 100),
      [waitForNodeModules]
    );
  }
  //#endregion

  async resetAppPermissions(permissionType: AppPermissionType) {
    const needsRestart = await this.deviceSession?.resetAppPermissions(permissionType);
    if (needsRestart) {
      this.restart(false, false);
    }
  }

  async getDeepLinksHistory() {
    return extensionContext.workspaceState.get<string[] | undefined>(DEEP_LINKS_HISTORY_KEY) ?? [];
  }

  async openDeepLink(link: string) {
    const history = await this.getDeepLinksHistory();
    if (history.length === 0 || link !== history[0]) {
      extensionContext.workspaceState.update(
        DEEP_LINKS_HISTORY_KEY,
        [link, ...history.filter((s) => s !== link)].slice(0, DEEP_LINKS_HISTORY_LIMIT)
      );
    }

    this.deviceSession?.sendDeepLink(link);
  }

  public async dispatchTouches(touches: Array<TouchPoint>, type: "Up" | "Move" | "Down") {
    this.deviceSession?.sendTouches(touches, type);
  }

  public async dispatchKeyPress(keyCode: number, direction: "Up" | "Down") {
    this.deviceSession?.sendKey(keyCode, direction);
  }

  public async inspectElementAt(
    xRatio: number,
    yRatio: number,
    requestStack: boolean,
    callback: (inspectData: InspectData) => void
  ) {
    this.deviceSession?.inspectElementAt(xRatio, yRatio, requestStack, (inspectData) => {
      let stack = undefined;
      if (requestStack && inspectData?.stack) {
        stack = inspectData.stack;
        const inspectorExcludePattern = workspace
          .getConfiguration("RadonIDE")
          .get("inspectorExcludePattern") as string | undefined;
        const patterns = inspectorExcludePattern?.split(",").map((pattern) => pattern.trim());
        function testInspectorExcludeGlobPattern(filename: string) {
          return patterns?.some((pattern) => minimatch(filename, pattern));
        }
        stack.forEach((item: any) => {
          item.hide = false;
          if (!isAppSourceFile(item.source.fileName)) {
            item.hide = true;
          } else if (testInspectorExcludeGlobPattern(item.source.fileName)) {
            item.hide = true;
          }
        });
      }
      callback({ frame: inspectData.frame, stack });
    });
  }

  public async resumeDebugger() {
    this.deviceSession?.resumeDebugger();
  }

  public async stepOverDebugger() {
    this.deviceSession?.stepOverDebugger();
  }

  public async focusBuildOutput() {
    this.deviceSession?.focusBuildOutput();
  }

  public async focusExtensionLogsOutput() {
    Logger.openOutputPanel();
  }

  public async focusDebugConsole() {
    commands.executeCommand("workbench.panel.repl.view.focus");
  }

  public async openNavigation(navigationItemID: string) {
    this.deviceSession?.openNavigation(navigationItemID);
  }

  public async openDevMenu() {
    await this.deviceSession?.openDevMenu();
  }

  public startPreview(appKey: string) {
    this.deviceSession?.startPreview(appKey);
  }

  public async showStorybookStory(componentTitle: string, storyName: string) {
    if (await this.dependencyManager.checkProjectUsesStorybook()) {
      this.devtools.send("RNIDE_showStorybookStory", { componentTitle, storyName });
    } else {
      window.showErrorMessage("Storybook is not installed.", "Dismiss");
    }
  }

  public async getDeviceSettings() {
    return this.deviceSettings;
  }

  public async updateDeviceSettings(settings: DeviceSettings) {
    this.deviceSettings = settings;
    extensionContext.workspaceState.update(DEVICE_SETTINGS_KEY, settings);
    let needsRestart = await this.deviceSession?.changeDeviceSettings(settings);
    this.eventEmitter.emit("deviceSettingsChanged", this.deviceSettings);

    if (needsRestart) {
      await this.restart(false, false, true);
    }
  }

  public async renameDevice(deviceInfo: DeviceInfo, newDisplayName: string) {
    await this.deviceManager.renameDevice(deviceInfo, newDisplayName);
    deviceInfo.displayName = newDisplayName;
    if (this.projectState.selectedDevice?.id === deviceInfo.id) {
      this.updateProjectState({ selectedDevice: deviceInfo });
    }
  }

  public async sendBiometricAuthorization(isMatch: boolean) {
    await this.deviceSession?.sendBiometricAuthorization(isMatch);
  }

  private reportStageProgress(stageProgress: number, stage: string) {
    if (stage !== this.projectState.startupMessage) {
      return;
    }
    this.updateProjectState({ stageProgress });
  }

  private updateProjectState(newState: Partial<ProjectState>) {
    // stageProgress is tied to a startup stage, so when there is a change of status or startupMessage,
    // we always want to reset the progress.
    if (newState.status !== undefined || newState.startupMessage !== undefined) {
      delete this.projectState.stageProgress;
    }
    this.projectState = { ...this.projectState, ...newState };
    this.eventEmitter.emit("projectStateChanged", this.projectState);
  }

  private updateProjectStateForDevice(deviceInfo: DeviceInfo, newState: Partial<ProjectState>) {
    if (deviceInfo === this.projectState.selectedDevice) {
      this.updateProjectState(newState);
    }
  }

  public async updatePreviewZoomLevel(zoom: ZoomLevelType): Promise<void> {
    this.updateProjectState({ previewZoom: zoom });
    extensionContext.workspaceState.update(PREVIEW_ZOOM_KEY, zoom);
  }

  private async maybeInstallNodeModules() {
    const installed = await this.dependencyManager.checkNodeModulesInstallationStatus();

    if (!installed) {
      Logger.info("Installing node modules");
      await this.dependencyManager.installNodeModules();
      Logger.debug("Installing node modules succeeded");
    } else {
      Logger.debug("Node modules already installed - skipping");
    }
  }

  //#region Select device
  private async selectDeviceOnly(deviceInfo: DeviceInfo) {
    let device: IosSimulatorDevice | AndroidEmulatorDevice | undefined;
    try {
      device = await this.deviceManager.acquireDevice(deviceInfo);
    } catch (e) {
      if (e instanceof DeviceAlreadyUsedError) {
        window.showErrorMessage(
          "This device is already used by other instance of Radon IDE.\nPlease select another device",
          "Dismiss"
        );
      } else {
        Logger.error(`Couldn't acquire the device ${deviceInfo.platform} – ${deviceInfo.id}`, e);
      }
    }

    if (device) {
      Logger.log("Device selected", deviceInfo.displayName);
      extensionContext.workspaceState.update(LAST_SELECTED_DEVICE_KEY, deviceInfo.id);
      return device;
    }
    return undefined;
  }

  public async selectDevice(deviceInfo: DeviceInfo, forceCleanBuild = false) {
    const device = await this.selectDeviceOnly(deviceInfo);
    if (!device) {
      return false;
    }
    Logger.debug("Selected device is ready");

    this.deviceSession?.dispose();
    this.deviceSession = undefined;

    this.updateProjectState({
      selectedDevice: deviceInfo,
      status: "starting",
      startupMessage: StartupMessage.InitializingDevice,
      previewURL: undefined,
    });

    let newDeviceSession;
    try {
      newDeviceSession = new DeviceSession(
        device,
        this.devtools,
        this.metro,
        this.dependencyManager,
        this,
        this
      );
      this.deviceSession = newDeviceSession;

      const previewURL = await newDeviceSession.start(this.deviceSettings, {
        cleanBuild: forceCleanBuild,
        previewReadyCallback: (url) => {
          this.updateProjectStateForDevice(deviceInfo, { previewURL: url });
        },
      });
      this.updateProjectStateForDevice(this.projectState.selectedDevice!, {
        previewURL,
        status: "running",
      });
    } catch (e) {
      Logger.error("Couldn't start device session", e);

      const isSelected = this.projectState.selectedDevice === deviceInfo;
      const isNewSession = this.deviceSession === newDeviceSession;
      if (isSelected && isNewSession) {
        this.updateProjectState({ status: "buildError" });
      }
    }
    return true;
  }
  //#endregion

  // used in callbacks, needs to be an arrow function
  private removeDeviceListener = async (device: DeviceInfo) => {
    if (this.projectState.selectedDevice?.id === device.id) {
      this.updateProjectState({ status: "starting" });
      await this.trySelectingInitialDevice();
    }
  };

  private checkIfNativeChanged = throttleAsync(async () => {
    if (!this.isCachedBuildStale && this.projectState.selectedDevice) {
      const platform = this.projectState.selectedDevice.platform;
      const isCacheStale = await PlatformBuildCache.forPlatform(platform).isCacheStale();

      if (isCacheStale) {
        this.isCachedBuildStale = true;
        this.eventEmitter.emit("needsNativeRebuild");
      }
    }
  }, 1000);
}

function watchProjectFiles(onChange: () => void) {
  // VS code glob patterns don't support negation so we can't exclude
  // native build directories like android/build, android/.gradle,
  // android/app/build, or ios/build.
  // VS code by default exclude .git and node_modules directories from
  // watching, configured by `files.watcherExclude` setting.
  //
  // We may revisit this if better performance is needed and create
  // recursive watches ourselves by iterating through workspace directories
  // to workaround this issue.

  const savedFileWatcher = workspace.onDidSaveTextDocument(onChange);

  const watcher = workspace.createFileSystemWatcher("**/*");
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);

  return {
    dispose: () => {
      watcher.dispose();
      savedFileWatcher.dispose();
    },
  };
}

export function isAppSourceFile(filePath: string) {
  const relativeToWorkspace = workspace.asRelativePath(filePath, false);

  if (relativeToWorkspace === filePath) {
    // when path is outside of any workspace folder, workspace.asRelativePath returns the original path
    return false;
  }

  // if the relative path contain node_modules, we assume it's not user's app source file:
  return !relativeToWorkspace.includes("node_modules");
}
