// Renders the desktop shell's own pages from the product's loading surface.
//
//   node desktop/build-shell-pages.mjs [--check]
//
// The window shows two pages outside the Next app: one while the local host
// is starting, one if it stopped. They must be the same loading screen the
// product uses everywhere else, but a page loaded from app.asar with
// `loadFile` has no bundler, no React and no StyleX at runtime.
//
// So they are built here, twice from one source: `CloudLoadingSurface` is
// compiled with the same StyleX Babel options the app compiles with
// (studio/stylex.config.mjs), server-rendered to static markup for the first
// paint, and bundled for the browser so the page hydrates into the live
// component - the WebGL sky and all - the moment the script runs. The pages
// are literally the component's output, not a second design tracking it by
// hand, and they ship as plain files with relative hrefs, which is all
// `loadFile` can serve. Barlow, the product's body face, ships beside them
// because next/font is not here to load it.
//
// The output is committed, like desktop/build/icon.*: main.mjs loads these
// pages straight from this directory when Studio runs unpackaged, and staging
// must stay a copy step with no toolchain of its own. Re-run after touching
// the surface or its styles; `--check` fails when the committed files differ.
import { build } from "esbuild";
import babel from "@babel/core";
import stylexPlugin from "@stylexjs/babel-plugin";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stylexBabelConfig, stylexBabelOptions, stylexCompileRoots } from "../stylex.config.mjs";

const { processStylexRules } = stylexPlugin;
const desktopDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const studioUiSrc = join(
  dirname(require.resolve("@simforge-oss/studio-ui/package.json")),
  "src",
);

/** The Barlow weights the surface renders: detail 400, meta 500, title 600. */
const BARLOW = [
  [400, "barlow-400.woff2"],
  [500, "barlow-500.woff2"],
  [600, "barlow-600.woff2"],
];

/** The committed, generated files, in the order they are written. */
export const GENERATED_PAGES = [
  "cloud-loading.css",
  "cloud-loading.js",
  ...BARLOW.map(([, file]) => file),
  "starting.html",
  "host-exited.html",
];

/**
 * The two pages, as `CloudLoadingSurface` props. Shared by the server render
 * and the browser bundle, which renders the same element tree over it.
 */
const PAGE_CONTENT = {
  "starting.html": {
    surface: {
      title: "Starting the local host",
      detail:
        "Applying migrations, seeding, and waiting for the server to answer. Studio opens as soon as it does.",
      progress: null,
      progressLabel: "Local host",
      progressValueLabel: "Starting",
    },
  },
  "host-exited.html": {
    surface: {
      title: "The local host stopped",
      detail:
        "Studio can't reach its server. Durable jobs continue under their own supervisor and nothing on disk is affected. Quit and reopen SimForge Studio to start the host again.",
      role: "alert",
    },
    // The shell passes the exit status as `?code=`; `loadFile` has no other
    // way to parameterise a static page. The browser render fills it in.
    exitCode: true,
    // The stopped page is not working on anything: the spinner would lie.
    alertIcon: true,
  },
};

/**
 * The element tree of one page. Runs in Node for the static markup and in the
 * browser for hydration, so it is source text shared by both bundles.
 *
 * The exit status is the one thing the static page cannot know: the shell
 * passes it as `?code=`, and `ExitCode` reads it after mount, so the server
 * markup and the first client render agree on the placeholder.
 */
const PAGE_ELEMENT = `
  function ExitCode() {
    const [code, setCode] = useState("unknown");
    useEffect(() => {
      setCode(new URLSearchParams(location.search).get("code") ?? "unknown");
    }, []);
    return createElement(
      "p",
      {
        style: {
          marginTop: "1.5rem",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgb(255 255 255 / 35%)",
        },
      },
      "Exit code ",
      createElement("code", null, code),
    );
  }

  export function pageElement(name) {
    const page = PAGES[name];
    return createElement(
      CloudLoadingSurface,
      {
        scope: "screen",
        eyebrow: "SimForge",
        ...page.surface,
        icon: page.alertIcon
          ? createElement(CircleAlert, { "aria-hidden": "true", style: { width: "1.25rem", height: "1.25rem" } })
          : undefined,
      },
      page.exitCode ? createElement(ExitCode) : null,
    );
  }
`;

/**
 * `three` is only reachable through the animated backdrop, and the server
 * render never runs its effect: the canvas is SSR'd empty and the browser
 * bundle, which does include `three`, drives it.
 */
const THREE_STUB = {
  name: "three-stub",
  setup(esbuild) {
    esbuild.onResolve({ filter: /^three$/ }, () => ({ path: "three", namespace: "three-stub" }));
    esbuild.onLoad({ filter: /.*/, namespace: "three-stub" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

/**
 * Compile StyleX exactly as the app does, and keep every rule the compiler
 * emits so the page's stylesheet is the same atomic CSS the product renders.
 * @param {{ ltr: string; rtl?: string | null; priority: number }[][]} sink
 */
const stylexLoader = (sink) => ({
  name: "stylex",
  setup(esbuild) {
    esbuild.onLoad({ filter: /\.tsx?$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8");
      const loader = path.endsWith("x") ? "tsx" : "ts";
      if (!stylexCompileRoots.some((root) => path.startsWith(`${root}/`))) {
        return { contents: source, loader };
      }
      const result = await babel.transformAsync(source, {
        ...stylexBabelConfig,
        // `dev: false` is the production naming: no debug class names, and
        // therefore no absolute build paths baked into a committed file.
        plugins: [["@stylexjs/babel-plugin", { ...stylexBabelOptions, dev: false }]],
        filename: path,
      });
      if (result?.metadata?.stylex?.length) sink.push(result.metadata.stylex);
      return { contents: result?.code ?? source, loader };
    });
  },
});

/** Server-render both pages, collect the CSS their styles compiled to, and bundle the hydrating script. */
export async function renderShellPages() {
  const rules = [];
  const outDir = await mkdtemp(join(tmpdir(), "simforge-shell-pages-"));
  try {
    const shared = `
      import { createElement, useEffect, useState } from "react";
      import { CircleAlert } from "lucide-react";
      import { CloudLoadingSurface } from ${JSON.stringify(join(studioUiSrc, "components/CloudLoadingSurface"))};
      const PAGES = ${JSON.stringify(PAGE_CONTENT)};
      ${PAGE_ELEMENT}
    `;
    await build({
      stdin: {
        contents: `
          ${shared}
          export { renderToStaticMarkup } from "react-dom/server";
        `,
        resolveDir: desktopDir,
        loader: "ts",
      },
      outfile: join(outDir, "surface.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      jsx: "automatic",
      // Bundled CommonJS (react-dom/server) calls `require`; ESM has none.
      banner: { js: "import { createRequire as __req } from 'node:module';\nconst require = __req(import.meta.url);" },
      conditions: ["development"],
      // Errors only: stubbing `three` makes esbuild warn about every symbol
      // the animated backdrop imports from it.
      logLevel: "error",
      plugins: [THREE_STUB, stylexLoader(rules)],
    });
    const { pageElement, renderToStaticMarkup } = await import(pathToFileURL(join(outDir, "surface.mjs")).href);
    // The browser bundle: the same tree, hydrated over the static markup. The
    // StyleX rules it compiles are the same set; the sink is not read twice.
    await build({
      stdin: {
        contents: `
          ${shared}
          import { hydrateRoot } from "react-dom/client";
          hydrateRoot(document.getElementById("surface"), pageElement(document.documentElement.dataset.page));
        `,
        resolveDir: desktopDir,
        loader: "ts",
      },
      outfile: join(outDir, "cloud-loading.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome140",
      jsx: "automatic",
      minify: true,
      legalComments: "none",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "error",
      plugins: [stylexLoader([])],
    });
    const css = processStylexRules(rules.flat(), true);
    const pages = {
      "cloud-loading.css": `${await themeVariables()}\n${css.trim()}\n`,
      "cloud-loading.js": await readFile(join(outDir, "cloud-loading.js")),
    };
    const barlowDir = join(dirname(require.resolve("@fontsource/barlow/package.json")), "files");
    for (const [weight, file] of BARLOW) {
      pages[file] = await readFile(join(barlowDir, `barlow-latin-${weight}-normal.woff2`));
    }
    for (const name of Object.keys(PAGE_CONTENT)) {
      pages[name] = htmlPage(name, renderToStaticMarkup(pageElement(name)));
    }
    return pages;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

/**
 * The custom properties the compiled tokens bridge to, lifted from
 * `styles.css` so they cannot drift: its `:root` block, then its `.dark`
 * block, which `layout.tsx` pins for the whole product and which is
 * therefore the only theme these pages can be in.
 */
async function themeVariables() {
  const source = await readFile(join(studioUiSrc, "styles.css"), "utf8");
  const block = (selector) => {
    const match = source.match(new RegExp(`\\n  ${selector} \\{\\n([\\s\\S]*?)\\n  \\}`));
    if (!match) throw new Error(`${selector} block not found in styles.css`);
    return match[1].replace(/^ {2}/gm, "");
  };
  return `/* Lifted from packages/studio-ui/src/styles.css by desktop/build-shell-pages.mjs. */\n:root {\n${block(":root")}\n${block("\\.dark")}\n}\n`;
}

/**
 * @param {string} name
 * @param {string} markup
 */
function htmlPage(name, markup) {
  return `<!doctype html>
<!-- Generated by desktop/build-shell-pages.mjs from CloudLoadingSurface. Do not edit; run \`pnpm -F @simforge-oss/studio desktop:pages\`. -->
<html lang="en" data-page="${name}">
  <head>
    <meta charset="utf-8" />
    <title>SimForge Studio</title>
    <link rel="stylesheet" href="shell.css" />
    <link rel="stylesheet" href="cloud-loading.css" />
  </head>
  <body>
    <div class="drag"></div>
    <div id="surface">${markup}</div>
    <script src="cloud-loading.js"></script>
  </body>
</html>
`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const pages = await renderShellPages();
  const check = process.argv.includes("--check");
  const stale = [];
  for (const [name, contents] of Object.entries(pages)) {
    const path = join(desktopDir, name);
    if (check) {
      const current = await readFile(path).catch(() => null);
      if (!current || !current.equals(Buffer.from(contents))) stale.push(name);
      continue;
    }
    await writeFile(path, contents);
  }
  if (stale.length > 0) {
    process.stderr.write(`stale shell pages: ${stale.join(", ")} - run desktop:pages\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    component: "simforge-desktop-stage",
    event: check ? "shell-pages.current" : "shell-pages.written",
    pages: Object.keys(pages),
  })}\n`);
}
