/**
 * Side-effect stylesheet imports. A component that owns a third-party widget
 * (MapLibre's canvas chrome) imports that widget's stylesheet next to it, so
 * every consumer gets the styles by importing the component — the app does not
 * have to remember a global import. The bundler resolves these; TypeScript
 * needs to be told they are modules with no shape.
 */
declare module "*.css";
