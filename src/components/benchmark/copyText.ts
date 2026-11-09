/** Copies `text`, or logs it where the clipboard is refused; what happened, for a caption. */
export async function copyText(text: string, what: string): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return `Copied the ${what}.`;
  } catch {
    console.log(text);
    return `The clipboard was refused: the ${what} is in the console.`;
  }
}
