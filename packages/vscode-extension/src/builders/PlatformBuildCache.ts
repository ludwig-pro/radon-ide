import path, { join } from "path";
import fs from "fs";
import { createFingerprintAsync } from "@expo/fingerprint";
import { Logger } from "../Logger";
import { extensionContext, getAppRootFolder } from "../utilities/extensionContext";
import { DevicePlatform } from "../common/DeviceManager";
import { IOSBuildResult } from "./buildIOS";
import { AndroidBuildResult } from "./buildAndroid";
import { getLaunchConfiguration } from "../utilities/launchConfiguration";
import { runfingerprintCommand } from "./customBuild";
import { calculateMD5 } from "../utilities/common";
import { BuildResult } from "./BuildManager";
import { getAppCache, removeAppCache, setAppCache } from "../utilities/appCaches";
import { workspace } from "vscode";

const ANDROID_BUILD_CACHE_KEY = "android_build_cache";
const IOS_BUILD_CACHE_KEY = "ios_build_cache";

const IGNORE_PATHS = [
  path.join("android", ".gradle/**/*"),
  path.join("android", "build/**/*"),
  path.join("android", "app", "build/**/*"),
  path.join("ios", "build/**/*"),
  "**/node_modules/**/android/.cxx/**/*",
  "**/node_modules/**/.gradle/**/*",
  "**/node_modules/**/android/build/intermediates/cxx/**/*",
];

export type BuildCacheInfo = {
  fingerprint: string;
  buildHash: string;
  buildResult: AndroidBuildResult | IOSBuildResult;
};

export class PlatformBuildCache {
  static instances: Record<DevicePlatform, PlatformBuildCache | undefined> = {
    [DevicePlatform.Android]: undefined,
    [DevicePlatform.IOS]: undefined,
  };

  static forPlatform(platform: DevicePlatform): PlatformBuildCache {
    if (!this.instances[platform]) {
      this.instances[platform] = new PlatformBuildCache(platform);
    }

    return this.instances[platform];
  }

  private constructor(private readonly platform: DevicePlatform) {}

  get cacheKey() {
    return this.platform === DevicePlatform.Android ? ANDROID_BUILD_CACHE_KEY : IOS_BUILD_CACHE_KEY;
  }

  /**
   * Passed fingerprint should be calculated at the time build is started.
   */
  public async storeCache(buildFingerprint: string, build: BuildResult) {
    const appPath = await getAppHash(getAppPath(build));

    const cache = JSON.stringify({
      fingerprint: buildFingerprint,
      buildHash: appPath,
      buildResult: build,
    });

    setAppCache(this.cacheKey, cache);
  }

  public async clearCache() {
    removeAppCache(this.cacheKey);
  }

  public getCache() {
    const buildCache = getAppCache(this.cacheKey);
    if (!buildCache) {
      return undefined;
    }

    return JSON.parse(buildCache);
  }

  public async getBuild(currentFingerprint: string) {
    const cache: BuildCacheInfo | undefined = this.getCache();

    if (!cache) {
      Logger.debug("No cached build found.");
      return undefined;
    }

    const fingerprintsMatch = cache.fingerprint === currentFingerprint;
    if (!fingerprintsMatch) {
      Logger.info(
        `Fingerprint mismatch, cannot use cached build. Old: '${cache.fingerprint}', new: '${currentFingerprint}'.`
      );
      return undefined;
    }

    const build = cache.buildResult;
    const appPath = getAppPath(build);
    try {
      const builtAppExists = fs.existsSync(appPath);
      if (!builtAppExists) {
        Logger.info("Couldn't use cached build. App artifact not found.");
        return undefined;
      }

      const appHash = await getAppHash(appPath);
      const hashesMatch = appHash === cache.buildHash;
      if (hashesMatch) {
        Logger.info("Using cached build.");
        return build;
      }
    } catch (e) {
      // we only log the error and ignore it to allow new build to start
      Logger.error("Error while attempting to load cached build: ", e);
      return undefined;
    }
  }

  public async isCacheStale() {
    const currentFingerprint = await this.calculateFingerprint();
    const { fingerprint } = this.getCache() ?? {};

    return currentFingerprint !== fingerprint;
  }

  public async calculateFingerprint() {
    const customFingerprint = await this.calculateCustomFingerprint();

    if (customFingerprint) {
      return customFingerprint;
    }

    const fingerprint = await createFingerprintAsync(getAppRootFolder(), {
      ignorePaths: IGNORE_PATHS,
    });
    Logger.log(`Workspace fingerprint: '${fingerprint.hash}'`);
    return fingerprint.hash;
  }

  private async calculateCustomFingerprint() {
    const { customBuild, env } = getLaunchConfiguration();
    const configPlatform = (
      {
        [DevicePlatform.Android]: "android",
        [DevicePlatform.IOS]: "ios",
      } as const
    )[this.platform];
    const fingerprintCommand = customBuild?.[configPlatform]?.fingerprintCommand;

    if (!fingerprintCommand) {
      return undefined;
    }

    Logger.log(`Using custom fingerprint script '${fingerprintCommand}'`);
    const fingerprint = await runfingerprintCommand(fingerprintCommand, env);

    if (!fingerprint) {
      throw new Error("Failed to generate workspace fingerprint using custom script.");
    }

    Logger.log("Workspace fingerprint", fingerprint);
    return fingerprint;
  }
}

function getAppPath(build: BuildResult) {
  return build.platform === DevicePlatform.Android ? build.apkPath : build.appPath;
}

async function getAppHash(appPath: string) {
  return (await calculateMD5(appPath)).digest("hex");
}

export function migrateOldBuildCachesToNewStorage() {
  const platformKeys = [ANDROID_BUILD_CACHE_KEY, IOS_BUILD_CACHE_KEY];

  platformKeys.forEach((platformKey) => {
    const cache = extensionContext.workspaceState.get<BuildCacheInfo>(platformKey);
    if (!cache) {
      return;
    }

    // the old method stored json objects instead of strings
    setAppCache(platformKey, JSON.stringify(cache));

    // remove the old cache afterwords
    extensionContext.workspaceState.update(platformKey, undefined);
  });
}
