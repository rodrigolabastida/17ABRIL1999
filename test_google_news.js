const targetUrl = "https://news.google.com/rss/articles/CBMiSWh0dHBzOi8vd3d3LmVsc29sZGV0bGF4Y2FsYS5jb20ubXgvbG9jYWwvaW5hdWd1cmFuLW9icmEtZW4tY2FscHVsYWxwYW4v0gEA?oc=5";
try {
    const parts = targetUrl.split('articles/');
    const b64 = parts[parts.length - 1].split('?')[0];
    const decoded = Buffer.from(b64, 'base64').toString('binary');
    console.log("Decoded raw:", decoded);
    const urlMatch = decoded.match(/https?:\/\/[^\s\x00-\x1f!@#$%^&*()_+={}\[\]:;|<>,?]+/);
    if (urlMatch) console.log("Target URL:", urlMatch[0]);
} catch (e) {
    console.log("Error:", e.message);
}
