import { useState, useEffect } from "react";
import { vscode } from "../utilities/vscode";
import Preview from "../components/Preview";
import IconButton from "../components/shared/IconButton";
import UrlBar from "../components/UrlBar";
import SettingsDropdown from "../components/SettingsDropdown";
import "./View.css";
import "./PreviewView.css";
import { useModal } from "../providers/ModalProvider";
import ManageDevicesView from "./ManageDevicesView";
import DevicesNotFoundView from "./DevicesNotFoundView";
import DeviceSettingsDropdown from "../components/DeviceSettingsDropdown";
import DeviceSettingsIcon from "../components/icons/DeviceSettingsIcon";
import { useDevices } from "../providers/DevicesProvider";
import { useProject } from "../providers/ProjectProvider";
import DeviceSelect from "../components/DeviceSelect";
import Button from "../components/shared/Button";
import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react";

function PreviewView() {
  const [isInspecing, setIsInspecting] = useState(false);
  const [isFollowing, setIsFollowing] = useState(false);
  const [logCounter, setLogCounter] = useState(0);

  const { openModal } = useModal();

  const { devices, isLoading: isLoadingDevices } = useDevices();
  const { projectState, project } = useProject();

  const selectedDevice = projectState?.selectedDevice;
  const devicesNotFound = projectState !== undefined && devices.length === 0;

  useEffect(() => {
    function incrementLogCounter() {
      setLogCounter((c) => c + 1);
    }
    project.addListener("log", incrementLogCounter);

    return () => {
      project.removeListener("log", incrementLogCounter);
    };
  }, []);

  const handleDeviceDropdownChange = async (value) => {
    if (value === "manage") {
      openModal("Manage Devices", <ManageDevicesView />);
      return;
    }
    if (selectedDevice?.id !== value) {
      const deviceInfo = devices.find((d) => d.id === value);
      if (deviceInfo) {
        project.selectDevice(deviceInfo);
      }
    }
  };

  if (isLoadingDevices) {
    return (
      <div className="panel-view">
        <VSCodeProgressRing />
      </div>
    );
  }

  return (
    <div className="panel-view">
      <div className="button-group-top">
        <IconButton
          tooltip={{
            label: "Follow active editor on the device",
            side: "bottom",
          }}
          active={isFollowing}
          onClick={() => {
            vscode.postMessage({
              command: isFollowing ? "stopFollowing" : "startFollowing",
            });
            setIsFollowing(!isFollowing);
          }}
          disabled={
            devicesNotFound ||
            true /* for the time being we are disabling this functionality as it incurs some performance overhead we didn't yet have time to investigate */
          }>
          <span className="codicon codicon-magnet" />
        </IconButton>

        <span className="group-separator" />

        <UrlBar project={project} disabled={devicesNotFound} />

        <div className="spacer" />

        <Button
          counter={logCounter}
          onClick={() => {
            setLogCounter(0);
            project.focusDebugConsole();
          }}
          tooltip={{
            label: "Open logs panel",
          }}
          disabled={devicesNotFound}>
          <span slot="start" className="codicon codicon-debug-console" />
          Logs
        </Button>
        <SettingsDropdown project={project} disabled={devicesNotFound}>
          <IconButton
            onClick={() => {
              vscode.postMessage({ command: "openSettings" });
            }}
            tooltip={{ label: "Settings", side: "bottom" }}>
            <span className="codicon codicon-settings-gear" />
          </IconButton>
        </SettingsDropdown>
      </div>
      {selectedDevice ? (
        <Preview
          key={selectedDevice.id}
          isInspecting={isInspecing}
          setIsInspecting={setIsInspecting}
        />
      ) : (
        <div className="missing-device-filler">
          {devicesNotFound ? <DevicesNotFoundView /> : <VSCodeProgressRing />}
        </div>
      )}

      <div className="button-group-bottom">
        <IconButton
          active={isInspecing}
          tooltip={{
            label: "Select an element to inspect it",
          }}
          onClick={() => setIsInspecting(!isInspecing)}
          disabled={devicesNotFound}>
          <span className="codicon codicon-inspect" />
        </IconButton>

        <span className="group-separator" />

        <DeviceSelect
          devices={devices}
          value={selectedDevice?.id}
          label={selectedDevice?.name}
          onValueChange={handleDeviceDropdownChange}
          disabled={devicesNotFound}
        />

        <div className="spacer" />
        <DeviceSettingsDropdown disabled={devicesNotFound}>
          <IconButton tooltip={{ label: "Device settings", side: "top" }}>
            <DeviceSettingsIcon
              color={devicesNotFound ? "var(--disabled-text)" : "var(--default-text)"}
            />
          </IconButton>
        </DeviceSettingsDropdown>
      </div>
    </div>
  );
}

export default PreviewView;