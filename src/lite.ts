import './ui/scss/style.scss';
import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice, Mat4, Vec3 } from 'playcanvas';

import { Events } from './events';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { CreateDropHandler } from './drop-handler';
import { MappedReadFileSystem } from './io';
import { Shortcuts, ShortcutBinding } from './shortcuts';

declare global {
    interface Window {
        scene: Scene;
    }
}

// Default shortcut bindings for lite version
const liteShortcuts: Record<string, ShortcutBinding> = {
    // Camera fly keys - WASD + QE
    'camera.fly.forward': { codes: ['KeyW'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.backward': { codes: ['KeyS'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.left': { codes: ['KeyA'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.right': { codes: ['KeyD'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.down': { codes: ['KeyQ'], held: true, shift: 'optional', alt: 'optional' },
    'camera.fly.up': { codes: ['KeyE'], held: true, shift: 'optional', alt: 'optional' },
    'camera.modifier.fast': { codes: ['ShiftLeft', 'ShiftRight'], held: true, alt: 'optional' },
    'camera.modifier.slow': { codes: ['AltLeft', 'AltRight'], held: true, shift: 'optional' },

    // Camera controls
    'camera.reset': { keys: ['f'], shift: 'required' },
    'camera.focus': { keys: ['f'] },
    'camera.toggleControlMode': { keys: ['v'] },
    'grid.toggleVisible': { keys: ['g'] },

    // Tool
    'tool.deactivate': { keys: ['Escape'] },
    'select.delete': { keys: ['Delete', 'Backspace'] },
    'measure.clearAll': { keys: ['c'], shift: 'required' }
};

const main = async () => {
    // root events object
    const events = new Events();

    // Configure WebP WASM for SOG format
    WebPCodec.wasmUrl = new URL('static/lib/webp/webp.wasm', document.baseURI).toString();

    // Initialize shortcuts with real keyboard handling
    const shortcuts = new Shortcuts(events);
    for (const id in liteShortcuts) {
        const binding = liteShortcuts[id];
        shortcuts.register({
            event: id,
            keys: binding.keys,
            codes: binding.codes,
            ctrl: binding.ctrl,
            shift: binding.shift,
            alt: binding.alt,
            held: binding.held,
            repeat: binding.repeat,
            capture: binding.capture
        });
    }

    // shortcutManager stub (needed by some modules)
    const shortcutManager = {
        register: () => {},
        get: (): any => undefined,
        formatShortcut: (): string => ''
    };
    events.function('shortcutManager', () => shortcutManager);

    // get DOM elements
    const canvasContainer = document.getElementById('canvas-container')!;
    const toolsContainer = document.getElementById('tools-container')! as HTMLDivElement;
    const canvas = document.getElementById('canvas')! as HTMLCanvasElement;
    const cursorLabel = document.getElementById('cursor-label')!;
    const dropOverlay = document.getElementById('drop-overlay')!;
    const spinner = document.getElementById('spinner')!;
    const openFileBtn = document.getElementById('open-file-btn')!;
    const measureBtn = document.getElementById('measure-btn')!;
    const clearMeasureBtn = document.getElementById('clear-measure-btn')!;

    // create the graphics device
    const graphicsDevice = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgl2'],
        antialias: false,
        depth: false,
        stencil: false,
        xrCompatible: false,
        powerPreference: 'high-performance'
    });

    // resolve scene config
    const sceneConfig = getSceneConfig([]);

    // construct the scene
    const scene = new Scene(
        events,
        sceneConfig,
        canvas,
        graphicsDevice
    );

    // colors
    const bgClr = new Color();
    const selectedClr = new Color();
    const unselectedClr = new Color();
    const lockedClr = new Color();

    const setClr = (target: Color, value: Color, event: string) => {
        if (!target.equals(value)) {
            target.copy(value);
            events.fire(event, target);
        }
    };

    const setBgClr = (clr: Color) => setClr(bgClr, clr, 'bgClr');
    const setSelectedClr = (clr: Color) => setClr(selectedClr, clr, 'selectedClr');
    const setUnselectedClr = (clr: Color) => setClr(unselectedClr, clr, 'unselectedClr');
    const setLockedClr = (clr: Color) => setClr(lockedClr, clr, 'lockedClr');

    events.on('setBgClr', (clr: Color) => setBgClr(clr));
    events.on('setSelectedClr', (clr: Color) => setSelectedClr(clr));
    events.on('setUnselectedClr', (clr: Color) => setUnselectedClr(clr));
    events.on('setLockedClr', (clr: Color) => setLockedClr(clr));

    events.function('bgClr', () => bgClr);
    events.function('selectedClr', () => selectedClr);
    events.function('unselectedClr', () => unselectedClr);
    events.function('lockedClr', () => lockedClr);

    events.on('bgClr', (clr: Color) => {
        const cnv = (v: number) => `${Math.max(0, Math.min(255, (v * 255))).toFixed(0)}`;
        document.body.style.backgroundColor = `rgba(${cnv(clr.r)},${cnv(clr.g)},${cnv(clr.b)},1)`;
    });
    events.on('selectedClr', () => { scene.forceRender = true; });
    events.on('unselectedClr', () => { scene.forceRender = true; });
    events.on('lockedClr', () => { scene.forceRender = true; });

    // initialize colors from config
    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // minimal editor events (only what's needed for camera, grid, and measure)
    registerMinimalEditorEvents(events, scene);

    // ===== CUSTOM MEASURE TOOL (multi-point, no gizmo) =====
    const measureState = {
        active: false,
        points: [] as Vec3[]     // world-space measure points
    };

    // Create SVG overlay for measure visualization
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'measure-tool-svg';
    svg.classList.add('hidden');
    toolsContainer.appendChild(svg);

    const ns = svg.namespaceURI!;

    // Create defs with arrow marker
    const defs = document.createElementNS(ns, 'defs');

    // Arrow marker for direction indication
    const marker = document.createElementNS(ns, 'marker');
    marker.setAttribute('id', 'arrowhead');
    marker.setAttribute('markerWidth', '10');
    marker.setAttribute('markerHeight', '7');
    marker.setAttribute('refX', '10');
    marker.setAttribute('refY', '3.5');
    marker.setAttribute('orient', 'auto');
    const markerPolygon = document.createElementNS(ns, 'polygon');
    markerPolygon.setAttribute('points', '0 0, 10 3.5, 0 7');
    markerPolygon.setAttribute('fill', '#ff6600');
    marker.appendChild(markerPolygon);
    defs.appendChild(marker);

    // Line template
    const lineTemplate = document.createElementNS(ns, 'line') as SVGLineElement;
    lineTemplate.id = 'measure-line';
    lineTemplate.setAttribute('stroke', '#ff6600');
    lineTemplate.setAttribute('stroke-width', '2');
    defs.appendChild(lineTemplate);

    svg.appendChild(defs);

    // We'll dynamically create line/circle elements per segment
    const svgLines: SVGUseElement[] = [];
    const svgCircles: SVGCircleElement[] = [];
    const svgLabels: SVGTextElement[] = [];

    const ensureSvgElements = () => {
        // Ensure we have enough SVG elements for current points
        // Each segment needs a line, each point needs a circle
        // Between each pair of consecutive points, show distance label

        // Circles for points
        while (svgCircles.length < measureState.points.length) {
            const circle = document.createElementNS(ns, 'circle') as SVGCircleElement;
            circle.setAttribute('r', '5');
            circle.setAttribute('fill', '#ff6600');
            circle.setAttribute('stroke', '#fff');
            circle.setAttribute('stroke-width', '1');
            circle.style.cursor = 'pointer';
            circle.style.pointerEvents = 'auto';
            svg.appendChild(circle);
            svgCircles.push(circle);
        }
        // Remove excess circles
        while (svgCircles.length > measureState.points.length) {
            const c = svgCircles.pop()!;
            svg.removeChild(c);
        }

        // Lines between consecutive points (n-1 lines for n points)
        const lineCount = Math.max(0, measureState.points.length - 1);
        while (svgLines.length < lineCount) {
            const lineUse = document.createElementNS(ns, 'use') as SVGUseElement;
            lineUse.setAttribute('href', '#measure-line');
            svg.appendChild(lineUse);
            svgLines.push(lineUse);
        }
        while (svgLines.length > lineCount) {
            const l = svgLines.pop()!;
            svg.removeChild(l);
        }

        // Distance labels between consecutive points
        const labelCount = lineCount;
        while (svgLabels.length < labelCount) {
            const text = document.createElementNS(ns, 'text') as SVGTextElement;
            text.setAttribute('fill', '#fff');
            text.setAttribute('font-size', '12');
            text.setAttribute('font-family', 'monospace');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('stroke', '#000');
            text.setAttribute('stroke-width', '2');
            text.setAttribute('paint-order', 'stroke');
            svg.appendChild(text);
            svgLabels.push(text);
        }
        while (svgLabels.length > labelCount) {
            const t = svgLabels.pop()!;
            svg.removeChild(t);
        }
    };

    // Project 3D world point to 2D screen coordinates
    const tmpVec = new Vec3();
    const worldToScreen = (worldPos: Vec3): { x: number, y: number } | null => {
        scene.camera.worldToScreen(worldPos, tmpVec);
        return {
            x: tmpVec.x * canvasContainer.clientWidth,
            y: tmpVec.y * canvasContainer.clientHeight
        };
    };

    const updateMeasureVisuals = () => {
        ensureSvgElements();

        // Update circles
        for (let i = 0; i < measureState.points.length; i++) {
            const screen = worldToScreen(measureState.points[i]);
            if (screen) {
                svgCircles[i].setAttribute('cx', screen.x.toString());
                svgCircles[i].setAttribute('cy', screen.y.toString());
                svgCircles[i].setAttribute('visibility', 'visible');
            } else {
                svgCircles[i].setAttribute('visibility', 'hidden');
            }
        }

        // Update lines and labels
        for (let i = 0; i < measureState.points.length - 1; i++) {
            const screenA = worldToScreen(measureState.points[i]);
            const screenB = worldToScreen(measureState.points[i + 1]);
            if (screenA && screenB) {
                svgLines[i].setAttribute('x1', screenA.x.toString());
                svgLines[i].setAttribute('y1', screenA.y.toString());
                svgLines[i].setAttribute('x2', screenB.x.toString());
                svgLines[i].setAttribute('y2', screenB.y.toString());
                svgLines[i].setAttribute('visibility', 'visible');

                // Distance label
                const dist = measureState.points[i].distance(measureState.points[i + 1]);
                const midX = (screenA.x + screenB.x) / 2;
                const midY = (screenA.y + screenB.y) / 2;
                svgLabels[i].setAttribute('x', midX.toString());
                svgLabels[i].setAttribute('y', (midY - 8).toString());
                svgLabels[i].textContent = `${dist.toFixed(3)}m`;
                svgLabels[i].setAttribute('visibility', 'visible');
            } else {
                svgLines[i].setAttribute('visibility', 'hidden');
                svgLabels[i].setAttribute('visibility', 'hidden');
            }
        }
    };

    // Delete last measure point
    const deleteLastMeasurePoint = () => {
        if (measureState.points.length > 0) {
            const removed = measureState.points.pop()!;
            console.log(`[Measure] Deleted point: (${removed.x.toFixed(4)}, ${removed.y.toFixed(4)}, ${removed.z.toFixed(4)})`);
            console.log(`[Measure] Remaining points: ${measureState.points.length}`);
            updateMeasureVisuals();
        }
    };

    // Clear all measure points
    const clearAllMeasurePoints = () => {
        measureState.points = [];
        updateMeasureVisuals();
        console.log('[Measure] All points cleared');
    };

    // Pointer handling for measure tool
    let measureClicked = false;

    const isPrimary = (e: PointerEvent) => {
        return e.pointerType === 'mouse' ? e.button === 0 : e.isPrimary;
    };

    const measurePointerdown = (e: PointerEvent) => {
        if (isPrimary(e)) {
            measureClicked = true;
        }
    };

    const measurePointermove = (e: PointerEvent) => {
        measureClicked = false;
    };

    const measurePointerup = async (e: PointerEvent) => {
        if (!measureClicked || !isPrimary(e)) return;
        measureClicked = false;

        // Check if click is near an existing point (for selection/deletion)
        for (let i = 0; i < measureState.points.length; i++) {
            const screen = worldToScreen(measureState.points[i]);
            if (screen && Math.abs(screen.x - e.offsetX) < 10 && Math.abs(screen.y - e.offsetY) < 10) {
                // Click near existing point - delete it
                const removed = measureState.points.splice(i, 1)[0];
                console.log(`[Measure] Deleted point ${i}: (${removed.x.toFixed(4)}, ${removed.y.toFixed(4)}, ${removed.z.toFixed(4)})`);
                console.log(`[Measure] Remaining points: ${measureState.points.length}`);
                updateMeasureVisuals();
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        // Pick new point from scene
        const result = await scene.camera.intersect(
            e.offsetX / canvasContainer.clientWidth,
            e.offsetY / canvasContainer.clientHeight
        );
        if (result) {
            const worldPos = result.position.clone();
            measureState.points.push(worldPos);
            console.log(`[Measure] Point ${measureState.points.length}: (${worldPos.x.toFixed(4)}, ${worldPos.y.toFixed(4)}, ${worldPos.z.toFixed(4)})`);

            // Calculate total distance
            if (measureState.points.length >= 2) {
                const lastTwo = [
                    measureState.points[measureState.points.length - 2],
                    measureState.points[measureState.points.length - 1]
                ];
                const segDist = lastTwo[0].distance(lastTwo[1]);
                console.log(`[Measure] Segment distance: ${segDist.toFixed(4)}m`);

                // Total path distance
                let totalDist = 0;
                for (let i = 0; i < measureState.points.length - 1; i++) {
                    totalDist += measureState.points[i].distance(measureState.points[i + 1]);
                }
                console.log(`[Measure] Total path distance: ${totalDist.toFixed(4)}m`);
            }

            updateMeasureVisuals();
        }

        e.preventDefault();
        e.stopPropagation();
    };

    // Activate measure tool
    const activateMeasure = () => {
        measureState.active = true;
        canvasContainer.addEventListener('pointerdown', measurePointerdown);
        canvasContainer.addEventListener('pointermove', measurePointermove);
        canvasContainer.addEventListener('pointerup', measurePointerup, true);
        toolsContainer.style.display = 'block';
        toolsContainer.classList.add('noevents');
        svg.classList.remove('hidden');
        measureBtn.classList.add('active');
        clearMeasureBtn.style.display = 'inline-block';
        updateMeasureVisuals();
    };

    // Deactivate measure tool
    const deactivateMeasure = () => {
        measureState.active = false;
        canvasContainer.removeEventListener('pointerdown', measurePointerdown);
        canvasContainer.removeEventListener('pointermove', measurePointermove);
        canvasContainer.removeEventListener('pointerup', measurePointerup);
        toolsContainer.style.display = 'none';
        toolsContainer.classList.remove('noevents');
        svg.classList.add('hidden');
        measureBtn.classList.remove('active');
    };

    // Tool manager integration
    events.function('tool.active', () => measureState.active ? 'measure' : null);

    events.on('tool.measure', () => {
        activateMeasure();
    });

    events.on('tool.deactivate', () => {
        deactivateMeasure();
        events.fire('tool.deactivated');
    });

    events.on('tool.deactivated', () => {
        measureBtn.classList.remove('active');
    });

    // Delete key: delete last point
    events.on('select.delete', () => {
        if (measureState.active) {
            deleteLastMeasurePoint();
        }
    });

    // Shift+C: clear all measure points
    events.on('measure.clearAll', () => {
        if (measureState.active) {
            clearAllMeasurePoints();
        }
    });

    // Update measure visuals on each render frame
    events.on('postrender', () => {
        if (measureState.active && measureState.points.length > 0) {
            updateMeasureVisuals();
        }
    });

    window.scene = scene;

    // cursor label - show picked point coordinates
    let fullprecision = '';
    events.on('camera.focalPointPicked', (details: { position: Vec3 }) => {
        cursorLabel.textContent = `${details.position.x.toFixed(2)}, ${details.position.y.toFixed(2)}, ${details.position.z.toFixed(2)}`;
        fullprecision = `${details.position.x}, ${details.position.y}, ${details.position.z}`;
    });

    ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'dblclick'].forEach((eventName) => {
        cursorLabel.addEventListener(eventName, (event: Event) => event.stopPropagation());
    });

    cursorLabel.addEventListener('pointerdown', () => {
        navigator.clipboard.writeText(fullprecision);
        const orig = cursorLabel.textContent;
        cursorLabel.textContent = 'Copied!';
        setTimeout(() => { cursorLabel.textContent = orig; }, 1000);
    });

    // spinner management
    let spinnerCount = 0;
    events.on('startSpinner', () => {
        spinnerCount++;
        if (spinnerCount === 1) spinner.style.display = 'block';
    });
    events.on('stopSpinner', () => {
        spinnerCount = Math.max(0, spinnerCount - 1);
        if (spinnerCount === 0) spinner.style.display = 'none';
    });

    // show popup (minimal - just alert)
    events.function('showPopup', async (options: any) => {
        if (options.type === 'error') {
            alert(`${options.header}: ${options.message}`);
        }
        return { action: 'ok' };
    });

    // selection support (minimal - just track current splat)
    let currentSplat: any = null;
    events.function('selection', () => currentSplat);
    events.on('selection.changed', (splat: any) => {
        currentSplat = splat;
    });

    // scene splats helpers
    events.function('scene.allSplats', () => scene.getElementsByType('splat' as any));
    events.function('scene.splats', () => {
        return (scene.getElementsByType('splat' as any) as any[])
            .filter((s: any) => s.visible && s.numSplats > 0);
    });
    events.function('scene.empty', () => {
        return events.invoke('scene.splats').length === 0;
    });

    // ===== FILE UPLOAD =====
    const importFiles = async (files: { filename: string; contents?: File; handle?: any; url?: string }[]) => {
        const filenames = files.map(f => f.filename.toLowerCase());

        for (let i = 0; i < files.length; i++) {
            const filename = filenames[i].toLowerCase();
            if (['.ply', '.splat', '.sog', '.ksplat', '.spz'].some(ext => filename.endsWith(ext))) {
                try {
                    events.fire('startSpinner');
                    const mainFile = files[i];
                    const baseUrl = mainFile.url ? new URL('.', new URL(mainFile.url, window.location.href)).href : undefined;
                    const fileSystem = new MappedReadFileSystem(baseUrl);
                    files.forEach((f) => {
                        if (f.contents) fileSystem.addFile(f.filename, f.contents);
                    });

                    const fn = (files.length === 1 && !mainFile.contents && mainFile.url) ?
                        mainFile.url : mainFile.filename;

                    const model = await scene.assetLoader.load(fn, fileSystem);
                    await scene.add(model);

                    // auto-select the loaded splat
                    events.fire('selection.changed', model);

                    // focus camera on loaded model
                    scene.camera.focus();
                } catch (error: any) {
                    alert(`Error loading file: ${error.message ?? error}`);
                } finally {
                    events.fire('stopSpinner');
                }
            }
        }
    };

    events.function('import', (files: any[], animationFrame = false) => {
        return importFiles(files);
    });

    events.function('scene.import', async () => {
        if (window.showOpenFilePicker) {
            try {
                const handles = await window.showOpenFilePicker({
                    id: 'SuperSplatFileImport',
                    multiple: true,
                    excludeAcceptAllOption: false,
                    types: [{
                        description: 'Supported Files',
                        accept: {
                            'application/ply': ['.ply'],
                            'application/x-gaussian-splat': ['.splat', '.ksplat', '.spz']
                        }
                    }]
                });
                const files = [];
                for (let i = 0; i < handles.length; i++) {
                    files.push({
                        filename: handles[i].name,
                        contents: await handles[i].getFile()
                    });
                }
                importFiles(files);
            } catch (error: any) {
                if (error.name !== 'AbortError') {
                    console.error(error);
                }
            }
        } else {
            // fallback for browsers without showOpenFilePicker
            const fileSelector = document.createElement('input');
            fileSelector.setAttribute('type', 'file');
            fileSelector.setAttribute('accept', '.ply,.splat,.ksplat,.spz');
            fileSelector.setAttribute('multiple', 'true');
            fileSelector.onchange = () => {
                const files = [];
                for (let i = 0; i < fileSelector.files!.length; i++) {
                    const file = fileSelector.files![i];
                    files.push({ filename: file.name, contents: file });
                }
                importFiles(files);
            };
            fileSelector.click();
        }
    });

    // open file button
    openFileBtn.addEventListener('click', () => {
        events.invoke('scene.import');
    });

    // drag and drop
    CreateDropHandler(canvasContainer, (entries, _shift) => {
        importFiles(entries.map((e: any) => ({
            filename: e.filename,
            contents: e.file,
            handle: e.handle
        })));
    });

    // also show drop overlay
    canvasContainer.addEventListener('dragenter', () => { dropOverlay.classList.add('active'); });
    canvasContainer.addEventListener('dragleave', (e) => {
        if (!canvasContainer.contains(e.relatedTarget as Node)) {
            dropOverlay.classList.remove('active');
        }
    });
    canvasContainer.addEventListener('drop', () => { dropOverlay.classList.remove('active'); });

    // measure button toggle
    measureBtn.addEventListener('click', () => {
        if (measureState.active) {
            events.fire('tool.deactivate');
        } else {
            events.fire('tool.measure');
        }
    });

    // clear measure button
    clearMeasureBtn.addEventListener('click', () => {
        clearAllMeasurePoints();
    });

    // initialize canvas size
    const pixelRatio = window.devicePixelRatio;
    canvas.width = Math.ceil(canvasContainer.offsetWidth * pixelRatio);
    canvas.height = Math.ceil(canvasContainer.offsetHeight * pixelRatio);

    // prevent context menu
    ['contextmenu', 'gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
        document.addEventListener(event, (e) => { e.preventDefault(); }, true);
    });

    // focus body on canvas click
    canvasContainer.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.target === canvas || toolsContainer.contains(event.target as Node)) {
            document.body.focus();
        }
    }, true);

    // start the scene
    scene.start();

    // fire initial events
    events.fire('camera.fov', scene.camera.fov);
    events.fire('camera.overlay', false);
    events.fire('view.bands', 3);
};

// Register minimal editor events needed for camera, grid, and tool functionality
const registerMinimalEditorEvents = (events: Events, scene: Scene) => {
    // force render on certain events
    [
        'camera.mode', 'camera.overlay', 'camera.splatSize', 'view.outlineSelection',
        'view.centersUseGaussianColor', 'view.bands', 'camera.bound', 'camera.showPoses',
        'selection.changed', 'tool.coordSpace'
    ].forEach((eventName) => {
        events.on(eventName, () => { scene.forceRender = true; });
    });

    // grid.visible - DEFAULT HIDDEN
    const setGridVisible = (visible: boolean) => {
        if (visible !== scene.grid.visible) {
            scene.grid.visible = visible;
            events.fire('grid.visible', visible);
        }
    };
    events.function('grid.visible', () => scene.grid.visible);
    events.on('grid.setVisible', (visible: boolean) => setGridVisible(visible));
    events.on('grid.toggleVisible', () => setGridVisible(!scene.grid.visible));
    setGridVisible(false); // DEFAULT: grid hidden

    // camera.fov
    const setCameraFov = (fov: number) => {
        if (fov !== scene.camera.fov) {
            scene.camera.fov = fov;
            events.fire('camera.fov', scene.camera.fov);
        }
    };
    events.function('camera.fov', () => scene.camera.fov);
    events.on('camera.setFov', (fov: number) => setCameraFov(fov));

    // camera.tonemapping
    events.function('camera.tonemapping', () => scene.camera.tonemapping);
    events.on('camera.setTonemapping', (value: string) => { scene.camera.tonemapping = value; });

    // camera.bound
    let bound = scene.config.show.bound;
    const setBoundVisible = (visible: boolean) => {
        if (visible !== bound) { bound = visible; events.fire('camera.bound', bound); }
    };
    events.function('camera.bound', () => bound);
    events.on('camera.setBound', (value: boolean) => setBoundVisible(value));

    // camera.showPoses
    let showPoses = scene.config.show.cameraPoses;
    const setShowPoses = (visible: boolean) => {
        if (visible !== showPoses) { showPoses = visible; events.fire('camera.showPoses', showPoses); }
    };
    events.function('camera.showPoses', () => showPoses);
    events.on('camera.setShowPoses', (value: boolean) => setShowPoses(value));

    // camera.focus
    events.on('camera.focus', () => {
        const splat = events.invoke('selection');
        if (splat?.visible) {
            const vec = new Vec3();
            const bound = splat.numSelected > 0 ? splat.selectionBound : splat.localBound;
            vec.copy(bound.center);
            const worldTransform = splat.worldTransform;
            worldTransform.transformPoint(vec, vec);
            const vec2 = new Vec3();
            worldTransform.getScale(vec2);
            scene.camera.focus({
                focalPoint: vec,
                radius: bound.halfExtents.length() * vec2.x,
                speed: 1
            });
        }
    });

    // camera.reset
    events.on('camera.reset', () => {
        const { initialAzim, initialElev, initialZoom } = scene.config.controls;
        const x = Math.sin(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const y = -Math.sin(initialElev * Math.PI / 180);
        const z = Math.cos(initialAzim * Math.PI / 180) * Math.cos(initialElev * Math.PI / 180);
        const zoom = initialZoom;
        scene.camera.setPose(new Vec3(x * zoom, y * zoom, z * zoom), new Vec3(0, 0, 0));
    });

    // camera mode (centers/rings)
    let activeMode = 'centers';
    const setCameraMode = (mode: string) => {
        if (mode !== activeMode) { activeMode = mode; events.fire('camera.mode', activeMode); }
    };
    events.function('camera.mode', () => activeMode);
    events.on('camera.setMode', (mode: string) => setCameraMode(mode));

    // camera control mode (orbit/fly)
    let controlMode: 'orbit' | 'fly' = 'orbit';
    const setControlMode = (mode: 'orbit' | 'fly') => {
        if (mode !== controlMode) {
            controlMode = mode;
            scene.camera.controlMode = mode;
            events.fire('camera.controlMode', controlMode);
        }
    };
    events.function('camera.controlMode', () => controlMode);
    events.on('camera.setControlMode', (mode: 'orbit' | 'fly') => setControlMode(mode));

    // camera overlay
    let cameraOverlay = scene.config.camera.overlay;
    const setCameraOverlay = (enabled: boolean) => {
        if (enabled !== cameraOverlay) { cameraOverlay = enabled; events.fire('camera.overlay', cameraOverlay); }
    };
    events.function('camera.overlay', () => cameraOverlay);
    events.on('camera.setOverlay', (value: boolean) => setCameraOverlay(value));

    // splat size
    let splatSize = 2;
    const setSplatSize = (value: number) => {
        if (value !== splatSize) { splatSize = value; events.fire('camera.splatSize', splatSize); }
    };
    events.function('camera.splatSize', () => splatSize);
    events.on('camera.setSplatSize', (value: number) => setSplatSize(value));

    // camera fly speed
    const setFlySpeed = (value: number) => {
        if (value !== scene.camera.flySpeed) {
            scene.camera.flySpeed = value;
            events.fire('camera.flySpeed', value);
        }
    };
    events.function('camera.flySpeed', () => scene.camera.flySpeed);
    events.on('camera.setFlySpeed', (value: number) => setFlySpeed(value));

    // outline selection
    let outlineSelection = false;
    const setOutlineSelection = (value: boolean) => {
        if (value !== outlineSelection) { outlineSelection = value; events.fire('view.outlineSelection', outlineSelection); }
    };
    events.function('view.outlineSelection', () => outlineSelection);
    events.on('view.setOutlineSelection', (value: boolean) => setOutlineSelection(value));

    // view spherical harmonic bands
    let viewBands = scene.config.show.shBands;
    const setViewBands = (value: number) => {
        if (value !== viewBands) { viewBands = value; events.fire('view.bands', viewBands); }
    };
    events.function('view.bands', () => viewBands);
    events.on('view.setBands', (value: number) => setViewBands(value));

    // centers gaussian color toggle
    let centersUseGaussianColor = false;
    events.function('view.centersUseGaussianColor', () => centersUseGaussianColor);
    events.on('view.setCentersUseGaussianColor', (value: boolean) => {
        centersUseGaussianColor = value;
        events.fire('view.centersUseGaussianColor', value);
    });

    // camera pose
    events.function('camera.getPose', () => {
        const camera = scene.camera;
        const position = camera.position;
        const focalPoint = camera.focalPoint;
        return {
            position: { x: position.x, y: position.y, z: position.z },
            target: { x: focalPoint.x, y: focalPoint.y, z: focalPoint.z },
            fov: camera.fov
        };
    });

    events.on('camera.setPose', (pose: { position: Vec3, target: Vec3, fov?: number }, speed = 1) => {
        scene.camera.setPose(pose.position, pose.target, speed);
        if (pose.fov !== undefined) {
            scene.camera.fov = pose.fov;
            events.fire('camera.fov', pose.fov);
        }
    });

    // camera ortho
    events.on('camera.setOrtho', (value: boolean) => { scene.camera.ortho = value; });

    // selection.splats
    events.function('selection.splats', () => {
        const splat = events.invoke('selection');
        return splat?.numSelected > 0;
    });

    // scene.dirty
    events.function('scene.dirty', () => false);

    // scene.clear
    events.on('scene.clear', () => {
        scene.clear();
    });

    // transform handler stack (stub for compatibility)
    const transformHandlerStack: any[] = [];
    events.on('transformHandler.push', (handler: any) => {
        transformHandlerStack.push(handler);
        if (handler.activate) handler.activate();
    });
    events.on('transformHandler.pop', () => {
        const handler = transformHandlerStack.pop();
        if (handler?.deactivate) handler.deactivate();
    });

    // pivot support (stub - no gizmo movement needed)
    const pivotTransform = {
        position: new Vec3(),
        rotation: null as any,
        scale: null as any,
        equals: () => false,
        copy: () => {},
        equalsTRS: () => false,
        set: () => {}
    };
    const pivot = {
        transform: pivotTransform,
        place: (t: any) => { events.fire('pivot.placed', pivot); },
        start: () => { events.fire('pivot.started', pivot); },
        move: (t: any) => { events.fire('pivot.moved', pivot); },
        moveTRS: (p: Vec3, r: any, s: any) => { events.fire('pivot.moved', pivot); },
        end: () => { events.fire('pivot.ended', pivot); }
    };
    events.function('pivot', () => pivot);
};

main();
