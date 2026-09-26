// Each test opens in its own tab; the popup closes when the tab opens.
function openTest(buttonId, page, name) {
  document.getElementById(buttonId).addEventListener("click", async () => {
    const extension = globalThis.browser;

    try {
      await extension.tabs.create({
        url: extension.runtime.getURL(page)
      });
      window.close();
    } catch (error) {
      document.getElementById("error").textContent = `Could not open the ${name} test: ${error.message}`;
    }
  });
}

openTest("open-camera", "debug.html", "camera");
openTest("test-audio", "audio.html", "microphone");
