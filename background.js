/* global chrome */

// Open the side panel when the user clicks the extension action.
function enableSidePanelBehavior() {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn("Failed to set side panel behavior", err);
    });
  } else {
    console.warn("chrome.sidePanel API not available");
  }
}

chrome.runtime.onInstalled.addListener(enableSidePanelBehavior);
chrome.runtime.onStartup.addListener(enableSidePanelBehavior);
