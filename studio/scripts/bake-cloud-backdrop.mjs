import { chromium } from "playwright-core";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// The shared smoke shader, baked offline: no runtime WebGL allocation is needed
// behind a city that already owns a multi-GiB graphics context. Alpha preserves
// the original composition over the common cloud plate.
const CLOUD_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const CLOUD_FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec2 uPointer;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x),
      f.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.52;
    mat2 rotation = mat2(0.80, 0.60, -0.60, 0.80);
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p = rotation * p * 2.03 + 9.7;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);
    p += uPointer * vec2(0.12, 0.06);

    vec2 farDrift = vec2(uTime * 0.028, uTime * 0.006);
    vec2 nearDrift = vec2(-uTime * 0.045, uTime * 0.009);

    float farShape = fbm(p * 2.15 + farDrift);
    float farDetail = fbm(p * 5.2 - farDrift * 0.7 + farShape);
    float farCloud = smoothstep(0.54, 0.73, farShape * 0.72 + farDetail * 0.42);

    float nearShape = fbm((p + vec2(0.7, -0.28)) * 1.55 + nearDrift);
    float nearDetail = fbm(p * 3.7 - nearDrift * 0.55 + nearShape * 1.3);
    float nearCloud = smoothstep(0.55, 0.76, nearShape * 0.76 + nearDetail * 0.40);

    float lowerBank = 1.0 - smoothstep(0.13, 0.68, uv.y);
    float upperWisps = smoothstep(0.56, 0.98, uv.y) * 0.56;
    float sideBanks = smoothstep(0.28, 0.98, abs(uv.x - 0.5) * 2.0) * 0.5;
    float cloudMask = clamp(lowerBank + upperWisps + sideBanks, 0.0, 1.0);

    float cloud = clamp(farCloud * 0.65 + nearCloud * 0.92, 0.0, 1.0) * cloudMask;
    float softHaze = fbm(p * 1.1 + farDrift * 0.4) * lowerBank * 0.13;
    vec3 shadowColor = vec3(0.22, 0.24, 0.25);
    vec3 lightColor = vec3(0.93, 0.94, 0.94);
    vec3 cloudColor = mix(shadowColor, lightColor, smoothstep(0.16, 0.82, cloud));
    float alpha = cloud * 0.72 + softHaze;

    gl_FragColor = vec4(cloudColor, alpha);
  }
`;


const studio = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const frames = await mkdtemp(join(tmpdir(), "simforge-cloud-frames-"));
const width = 960, height = 540, fps = 24, seconds = 24;
const bundle = await build({
  stdin: { contents: `import * as THREE from "three";
    const canvas=document.querySelector("canvas");
    const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,preserveDrawingBuffer:true});
    renderer.setSize(${width},${height},false);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.setClearColor(0x050607,0);
    const scene=new THREE.Scene();const camera=new THREE.PerspectiveCamera(38,${width/height},0.1,160);camera.position.set(0,1.2,17.288);
    const uniforms={uTime:{value:0},uResolution:{value:new THREE.Vector2(${width},${height})},uPointer:{value:new THREE.Vector2()}};
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(34,19),new THREE.ShaderMaterial({vertexShader:${JSON.stringify(CLOUD_VERTEX_SHADER)},fragmentShader:${JSON.stringify(CLOUD_FRAGMENT_SHADER)},uniforms,transparent:true,depthWrite:false,depthTest:false}));
    mesh.position.set(0,0.2,0);scene.add(mesh);
    window.ready=renderer.compileAsync(scene,camera);
    window.paint=(frame)=>{uniforms.uTime.value=12*(1-Math.cos(frame/${fps*seconds}*Math.PI*2));renderer.render(scene,camera)};`, resolveDir: studio },
  bundle: true, write: false, format: "iife",
});
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"], headless: true });
try {
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
  await page.setContent(`<body style="margin:0"><canvas style="width:100%;height:100%"></canvas></body>`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(() => window.ready);
  for(let frame=0;frame<fps*seconds;frame++) {
    const png = await page.evaluate(async frame => {
      window.paint(frame);
      await new Promise(resolve => requestAnimationFrame(resolve));
      window.paint(frame);
      if (document.querySelector("canvas").getContext("webgl2").isContextLost()) throw new Error("Cloud bake lost its WebGL context");
      return document.querySelector("canvas").toDataURL("image/png").split(",")[1];
    }, frame);
    await writeFile(join(frames,`${String(frame).padStart(4,"0")}.png`),Buffer.from(png,"base64"));
  }
  const destination=join(studio,"public/clouds");
  execFileSync("mkdir",["-p",destination]);
  execFileSync("ffmpeg",["-hide_banner","-loglevel","error","-y","-framerate",String(fps),"-i",join(frames,"%04d.png"),"-c:v","libvpx-vp9","-pix_fmt","yuva420p","-b:v","0","-crf","36","-row-mt","1",join(destination,"smoke.webm")]);
  await writeFile(join(destination,"smoke.png"),await readFile(join(frames,"0000.png")));
  console.log("Baked 24-second seamless smoke loop and reduced-motion still.");
} finally { await browser.close(); await rm(frames,{recursive:true,force:true}); }
