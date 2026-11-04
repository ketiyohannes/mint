/** Vite inlines `?raw` imports as strings (used for the bundled teach skill). */
declare module '*?raw' {
  const content: string
  export default content
}
