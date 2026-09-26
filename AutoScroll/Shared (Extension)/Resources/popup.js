document.querySelector('#test-audio').addEventListener('click', async () => {
    try {
        await browser.tabs.create({ url: browser.runtime.getURL('audio.html') });
        window.close();
    } catch (error) {
        document.querySelector('#status').textContent = 'Could not open the audio test. Please try again.';
    }
});
