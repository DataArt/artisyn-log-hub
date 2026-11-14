// Starts a browser download of a file or folder (folders come as `<name>.zip`, D12).

/** Opens `url` (an attachment response) through a temporary `<a download>`. */
export function triggerDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
