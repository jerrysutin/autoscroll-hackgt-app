document.getElementById("open-camera").addEventListener("click", async () => {
  const extension = globalThis.browser;

  try {
    await extension.tabs.create({
      url: extension.runtime.getURL("debug.html")
    });
    window.close();
  } catch (error) {
    document.getElementById("error").textContent = error.message;
  }
});