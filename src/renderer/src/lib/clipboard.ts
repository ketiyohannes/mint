/**
 * Puts text on the clipboard and reports whether it got there. The async
 * clipboard API needs the window to have focus; when it refuses, the text is
 * copied through a selection instead.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.setAttribute('readonly', '')
    holder.style.cssText = 'position: fixed; top: 0; left: 0; opacity: 0'
    document.body.append(holder)
    holder.select()
    const copied = document.execCommand('copy')
    holder.remove()
    return copied
  }
}
