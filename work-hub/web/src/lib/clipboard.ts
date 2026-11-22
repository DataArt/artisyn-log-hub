// Clipboard writes that also work when Work Hub is opened over plain http on the LAN.

/**
 * Puts text on the clipboard; resolves to whether it worked. `navigator.clipboard` exists only on
 * https and localhost; over plain http this falls back to a hidden textarea and
 * `execCommand("copy")`, which browsers still allow inside a user gesture. `refocus` puts the
 * focus back where it was (the fallback moves it to the textarea).
 */
export async function copyText(
  text: string,
  refocus?: () => void,
): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or no user gesture left: try the fallback below.
    }
  }
  return legacyCopy(text, refocus);
}

function legacyCopy(text: string, refocus?: () => void): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    refocus?.();
  }
}
