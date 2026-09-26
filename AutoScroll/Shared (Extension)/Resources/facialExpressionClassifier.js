const video = document.getElementById("camera");

let stream;

(async () => {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true });

    video.srcObject = stream;
    await video.play();
  } catch (error) {
    console.error("Could not start camera:", error);
  }
})();

window.addEventListener("pagehide", () => {
  stream?.getTracks().forEach(track => track.stop());
});