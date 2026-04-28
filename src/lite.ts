import './ui/scss/style.scss';
import { WebPCodec } from '@playcanvas/splat-transform';
import { Color, createGraphicsDevice, Mat4, Quat, Vec3 } from 'playcanvas';

import { EditHistory } from './edit-history';
import { EntityTransformOp, MultiOp, PlacePivotOp } from './edit-ops';
import { EntityTransformHandler } from './entity-transform-handler';
import { Events } from './events';
import { BrowserFileSystem } from './io/write/browser-file-system';
import { Pivot, registerPivotEvents } from './pivot';
import { Scene } from './scene';
import { getSceneConfig } from './scene-config';
import { serializePly, serializePlyCompressed, serializeSplat, SerializeSettings } from './splat-serialize';
import { CreateDropHandler } from './drop-handler';
import { MappedReadFileSystem } from './io';
import { MoveTool } from './tools/move-tool';
import { RotateTool } from './tools/rotate-tool';
import { ScaleTool } from './tools/scale-tool';
import { ToolManager } from './tools/tool-manager';
import { Transform } from './transform';
import { Shortcuts, ShortcutBinding } from './shortcuts';

declare global {
    interface Window {
        scene: Scene;
    }
}

// Shortcut bindings for lite version
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

    // Transform tools
    'tool.move': { keys: ['1'] },
    'tool.rotate': { keys: ['2'] },
    'tool.scale': { keys: ['3'] },

    // Tool
    'tool.deactivate': { keys: ['Escape'] },
    'select.delete': { keys: ['Delete', 'Backspace'] },
    'measure.clearAll': { keys: ['c'], shift: 'required' },

    // Undo/Redo
    'edit.undo': { keys: ['z'], ctrl: 'required', repeat: true, capture: true },
    'edit.redo': { keys: ['z'], ctrl: 'required', shift: 'required', repeat: true, capture: true },

    // Coord space toggle
    'tool.toggleCoordSpace': { keys: ['c'], shift: 'required' }
};

type ExportFormat = 'ply' | 'compressedPly' | 'splat';

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

    // shortcutManager stub
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
    const moveBtn = document.getElementById('move-btn')!;
    const rotateBtn = document.getElementById('rotate-btn')!;
    const scaleBtn = document.getElementById('scale-btn')!;
    const exportBtn = document.getElementById('export-btn')!;
    const exportMenu = document.getElementById('export-menu')!;

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

    // ===== PIVOT SYSTEM (real, from original project) =====
    registerPivotEvents(events);

    // ===== EDIT HISTORY =====
    const editHistory = new EditHistory(events);

    // ===== COLORS =====
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

    const toColor = (value: { r: number, g: number, b: number, a: number }) => {
        return new Color(value.r, value.g, value.b, value.a);
    };
    setBgClr(toColor(sceneConfig.bgClr));
    setSelectedClr(toColor(sceneConfig.selectedClr));
    setUnselectedClr(toColor(sceneConfig.unselectedClr));
    setLockedClr(toColor(sceneConfig.lockedClr));

    // ===== SELECTION SUPPORT =====
    let currentSplat: any = null;
    events.function('selection', () => currentSplat);
    events.on('selection.changed', (splat: any) => {
        currentSplat = splat;
    });

    events.function('scene.allSplats', () => scene.getElementsByType('splat' as any));
    events.function('scene.splats', () => {
        return (scene.getElementsByType('splat' as any) as any[])
            .filter((s: any) => s.visible && s.numSplats > 0);
    });
    events.function('scene.empty', () => {
        return events.invoke('scene.splats').length === 0;
    });

    // ===== TRANSFORM HANDLER (entity-level, from original project) =====
    const entityTransformHandler = new EntityTransformHandler(events);
    events.on('transformHandler.push', (handler: any) => {
        handler.activate();
    });
    events.on('transformHandler.pop', () => {
        entityTransformHandler.deactivate();
    });

    // ===== EDIT EVENTS =====
    registerMinimalEditorEvents(events, scene);

    // ===== TOOL MANAGER (real, from original project) =====
    const toolManager = new ToolManager(events);

    // Register transform tools
    toolManager.register('move', new MoveTool(events, scene));
    toolManager.register('rotate', new RotateTool(events, scene));
    toolManager.register('scale', new ScaleTool(events, scene));

    // Push/pop entity transform handler when transform tools activate/deactivate
    events.on('tool.move.activated', () => { entityTransformHandler.activate(); });
    events.on('tool.rotate.activated', () => { entityTransformHandler.activate(); });
    events.on('tool.scale.activated', () => { entityTransformHandler.activate(); });
    events.on('tool.move.deactivated', () => { entityTransformHandler.deactivate(); });
    events.on('tool.rotate.deactivated', () => { entityTransformHandler.deactivate(); });
    events.on('tool.scale.deactivated', () => { entityTransformHandler.deactivate(); });

    // ===== CUSTOM MEASURE TOOL (multi-point, no gizmo) =====
    const measureState = {
        active: false,
        points: [] as Vec3[]
    };

    // Create SVG overlay for measure visualization
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'measure-tool-svg';
    svg.classList.add('hidden');
    toolsContainer.appendChild(svg);

    const ns = svg.namespaceURI!;

    // Dynamic SVG elements
    const svgLinesBottom: SVGLineElement[] = [];  // bottom layer (black, thick)
    const svgLinesTop: SVGLineElement[] = [];      // top layer (white, thin)
    const svgCircles: SVGCircleElement[] = [];
    const svgLabels: SVGTextElement[] = [];
    const svgHitAreas: SVGRectElement[] = [];  // transparent hit areas for hover detection

    const ensureSvgElements = () => {
        // Circles for points - larger radius for visibility
        while (svgCircles.length < measureState.points.length) {
            const circle = document.createElementNS(ns, 'circle') as SVGCircleElement;
            circle.setAttribute('r', '8');
            circle.setAttribute('fill', '#ff6600');
            circle.setAttribute('stroke', '#fff');
            circle.setAttribute('stroke-width', '2');
            circle.style.cursor = 'pointer';
            circle.style.pointerEvents = 'auto';
            svg.appendChild(circle);
            svgCircles.push(circle);
        }
        while (svgCircles.length > measureState.points.length) {
            const c = svgCircles.pop()!;
            svg.removeChild(c);
        }

        const lineCount = Math.max(0, measureState.points.length - 1);

        // Hit areas for lines (transparent wider rects for hover detection)
        while (svgHitAreas.length < lineCount) {
            const hitArea = document.createElementNS(ns, 'rect') as SVGRectElement;
            hitArea.setAttribute('fill', 'transparent');
            hitArea.setAttribute('stroke', 'none');
            hitArea.style.cursor = 'pointer';
            hitArea.style.pointerEvents = 'stroke';
            hitArea.setAttribute('stroke-width', '16');
            hitArea.setAttribute('stroke', 'transparent');
            // Store reference to corresponding label index
            const idx = svgHitAreas.length;
            hitArea.addEventListener('pointerenter', () => {
                if (svgLabels[idx]) svgLabels[idx].setAttribute('visibility', 'visible');
            });
            hitArea.addEventListener('pointerleave', () => {
                if (svgLabels[idx]) svgLabels[idx].setAttribute('visibility', 'hidden');
            });
            svg.appendChild(hitArea);
            svgHitAreas.push(hitArea);
        }
        while (svgHitAreas.length > lineCount) {
            const h = svgHitAreas.pop()!;
            svg.removeChild(h);
        }

        // Lines between consecutive points - bottom layer (black, thick, drawn first)
        while (svgLinesBottom.length < lineCount) {
            const line = document.createElementNS(ns, 'line') as SVGLineElement;
            line.setAttribute('stroke', '#000');
            line.setAttribute('stroke-width', '6');
            svg.appendChild(line);
            svgLinesBottom.push(line);
        }
        while (svgLinesBottom.length > lineCount) {
            const l = svgLinesBottom.pop()!;
            svg.removeChild(l);
        }

        // Lines between consecutive points - top layer (white, thin, drawn on top)
        while (svgLinesTop.length < lineCount) {
            const line = document.createElementNS(ns, 'line') as SVGLineElement;
            line.setAttribute('stroke', '#fff');
            line.setAttribute('stroke-width', '2');
            svg.appendChild(line);
            svgLinesTop.push(line);
        }
        while (svgLinesTop.length > lineCount) {
            const l = svgLinesTop.pop()!;
            svg.removeChild(l);
        }

        // Distance labels (hidden by default, shown on hover)
        while (svgLabels.length < lineCount) {
            const text = document.createElementNS(ns, 'text') as SVGTextElement;
            text.setAttribute('fill', '#fff');
            text.setAttribute('font-size', '13');
            text.setAttribute('font-weight', 'bold');
            text.setAttribute('font-family', 'monospace');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('stroke', '#000');
            text.setAttribute('stroke-width', '3');
            text.setAttribute('paint-order', 'stroke');
            text.setAttribute('visibility', 'hidden');  // hidden by default
            text.style.pointerEvents = 'none';
            svg.appendChild(text);
            svgLabels.push(text);
        }
        while (svgLabels.length > lineCount) {
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

        for (let i = 0; i < measureState.points.length - 1; i++) {
            const screenA = worldToScreen(measureState.points[i]);
            const screenB = worldToScreen(measureState.points[i + 1]);
            if (screenA && screenB) {
                // Update bottom layer (black, thick)
                svgLinesBottom[i].setAttribute('x1', screenA.x.toString());
                svgLinesBottom[i].setAttribute('y1', screenA.y.toString());
                svgLinesBottom[i].setAttribute('x2', screenB.x.toString());
                svgLinesBottom[i].setAttribute('y2', screenB.y.toString());
                svgLinesBottom[i].setAttribute('visibility', 'visible');

                // Update top layer (white, thin)
                svgLinesTop[i].setAttribute('x1', screenA.x.toString());
                svgLinesTop[i].setAttribute('y1', screenA.y.toString());
                svgLinesTop[i].setAttribute('x2', screenB.x.toString());
                svgLinesTop[i].setAttribute('y2', screenB.y.toString());
                svgLinesTop[i].setAttribute('visibility', 'visible');

                // Distance label at midpoint
                const dist = measureState.points[i].distance(measureState.points[i + 1]);
                const midX = (screenA.x + screenB.x) / 2;
                const midY = (screenA.y + screenB.y) / 2;
                svgLabels[i].setAttribute('x', midX.toString());
                svgLabels[i].setAttribute('y', (midY - 10).toString());
                svgLabels[i].textContent = `${dist.toFixed(3)}m`;

                // Hit area - line between two points
                const dx = screenB.x - screenA.x;
                const dy = screenB.y - screenA.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len > 0) {
                    // Use a rotated rect as hit area along the line
                    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
                    const cx = midX;
                    const cy = midY;
                    svgHitAreas[i].setAttribute('x', (cx - len / 2).toString());
                    svgHitAreas[i].setAttribute('y', (cy - 8).toString());
                    svgHitAreas[i].setAttribute('width', len.toString());
                    svgHitAreas[i].setAttribute('height', '16');
                    svgHitAreas[i].setAttribute('transform', `rotate(${angle},${cx},${cy})`);
                    svgHitAreas[i].style.pointerEvents = 'fill';
                }
            } else {
                svgLinesBottom[i].setAttribute('visibility', 'hidden');
                svgLinesTop[i].setAttribute('visibility', 'hidden');
                svgLabels[i].setAttribute('visibility', 'hidden');
                svgHitAreas[i].style.pointerEvents = 'none';
            }
        }
    };

    const deleteLastMeasurePoint = () => {
        if (measureState.points.length > 0) {
            const removed = measureState.points.pop()!;
            console.log(`[Measure] Deleted point: (${removed.x.toFixed(4)}, ${removed.y.toFixed(4)}, ${removed.z.toFixed(4)})`);
            console.log(`[Measure] Remaining points: ${measureState.points.length}`);
            updateMeasureVisuals();
        }
    };

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

        // Check if click is near an existing point (for deletion)
        for (let i = 0; i < measureState.points.length; i++) {
            const screen = worldToScreen(measureState.points[i]);
            if (screen && Math.abs(screen.x - e.offsetX) < 12 && Math.abs(screen.y - e.offsetY) < 12) {
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

            if (measureState.points.length >= 2) {
                const segDist = measureState.points[measureState.points.length - 2].distance(measureState.points[measureState.points.length - 1]);
                console.log(`[Measure] Segment distance: ${segDist.toFixed(4)}m`);

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

    // Measure tool activate/deactivate
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
        // Make SVG circles have pointer events for deletion
        svg.style.pointerEvents = 'none';
        svgCircles.forEach(c => { c.style.pointerEvents = 'auto'; });
        updateMeasureVisuals();
    };

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

    // Override tool.active to include measure
    const originalToolActive = events.invoke('tool.active');
    // We need to hook into the tool manager's activate to handle measure tool
    // Measure tool is NOT registered with ToolManager - we handle it separately
    events.on('tool.measure', () => {
        // Deactivate any current tool manager tool first
        const current = events.invoke('tool.active');
        if (current) {
            toolManager.activate(null);
        }
        activateMeasure();
    });

    events.on('tool.deactivate', () => {
        if (measureState.active) {
            deactivateMeasure();
        }
        toolManager.activate(null);
        events.fire('tool.deactivated');
    });

    events.on('tool.deactivated', () => {
        measureBtn.classList.remove('active');
        moveBtn.classList.remove('active');
        rotateBtn.classList.remove('active');
        scaleBtn.classList.remove('active');
    });

    // When transform tools activate, deactivate measure
    events.on('tool.move.activated', () => {
        if (measureState.active) deactivateMeasure();
        moveBtn.classList.add('active');
        rotateBtn.classList.remove('active');
        scaleBtn.classList.remove('active');
        measureBtn.classList.remove('active');
    });
    events.on('tool.rotate.activated', () => {
        if (measureState.active) deactivateMeasure();
        moveBtn.classList.remove('active');
        rotateBtn.classList.add('active');
        scaleBtn.classList.remove('active');
        measureBtn.classList.remove('active');
    });
    events.on('tool.scale.activated', () => {
        if (measureState.active) deactivateMeasure();
        moveBtn.classList.remove('active');
        rotateBtn.classList.remove('active');
        scaleBtn.classList.add('active');
        measureBtn.classList.remove('active');
    });

    // Update measure visuals on each render frame
    events.on('postrender', () => {
        if (measureState.active && measureState.points.length > 0) {
            updateMeasureVisuals();
        }
    });

    window.scene = scene;

    // cursor label
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

    // show popup
    events.function('showPopup', async (options: any) => {
        if (options.type === 'error') {
            alert(`${options.header}: ${options.message}`);
        }
        return { action: 'ok' };
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

                    events.fire('selection.changed', model);
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

    canvasContainer.addEventListener('dragenter', () => { dropOverlay.classList.add('active'); });
    canvasContainer.addEventListener('dragleave', (e) => {
        if (!canvasContainer.contains(e.relatedTarget as Node)) {
            dropOverlay.classList.remove('active');
        }
    });
    canvasContainer.addEventListener('drop', () => { dropOverlay.classList.remove('active'); });

    // ===== TOOL BUTTONS =====
    measureBtn.addEventListener('click', () => {
        if (measureState.active) {
            events.fire('tool.deactivate');
        } else {
            events.fire('tool.measure');
        }
    });

    clearMeasureBtn.addEventListener('click', () => {
        clearAllMeasurePoints();
    });

    moveBtn.addEventListener('click', () => {
        if (events.invoke('tool.active') === 'move') {
            events.fire('tool.deactivate');
        } else {
            events.fire('tool.move');
        }
    });

    rotateBtn.addEventListener('click', () => {
        if (events.invoke('tool.active') === 'rotate') {
            events.fire('tool.deactivate');
        } else {
            events.fire('tool.rotate');
        }
    });

    scaleBtn.addEventListener('click', () => {
        if (events.invoke('tool.active') === 'scale') {
            events.fire('tool.deactivate');
        } else {
            events.fire('tool.scale');
        }
    });

    // ===== EXPORT =====
    const doExport = async (format: ExportFormat) => {
        const splats = events.invoke('scene.splats');
        if (!splats || splats.length === 0) {
            alert('No splats to export');
            return;
        }

        const firstSplat = splats[0];
        const filename = (firstSplat.name || 'output').replace(/\.[^.]+$/, '');

        const serializeSettings: SerializeSettings = {
            maxSHBands: 3
        };

        events.fire('startSpinner');

        try {
            await new Promise<void>((resolve) => { setTimeout(resolve); });

            let ext: string;
            const fs = new BrowserFileSystem(`${filename}${ext = format === 'splat' ? '.splat' : '.ply'}`);

            switch (format) {
                case 'ply':
                    await serializePly(splats, serializeSettings, fs);
                    break;
                case 'compressedPly':
                    serializeSettings.minOpacity = 1 / 255;
                    serializeSettings.removeInvalid = true;
                    await serializePlyCompressed(splats, serializeSettings, fs);
                    break;
                case 'splat':
                    await serializeSplat(splats, serializeSettings, fs);
                    break;
            }
        } catch (error: any) {
            alert(`Export error: ${error.message ?? error}`);
        } finally {
            events.fire('stopSpinner');
        }
    };

    // Export button - toggle dropdown
    exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        exportMenu.style.display = exportMenu.style.display === 'block' ? 'none' : 'block';
    });

    document.addEventListener('click', () => {
        exportMenu.style.display = 'none';
    });

    exportMenu.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    document.getElementById('export-ply')!.addEventListener('click', () => {
        doExport('ply');
        exportMenu.style.display = 'none';
    });

    document.getElementById('export-compressed-ply')!.addEventListener('click', () => {
        doExport('compressedPly');
        exportMenu.style.display = 'none';
    });

    document.getElementById('export-splat')!.addEventListener('click', () => {
        doExport('splat');
        exportMenu.style.display = 'none';
    });

    // ===== CANVAS INIT =====
    const pixelRatio = window.devicePixelRatio;
    canvas.width = Math.ceil(canvasContainer.offsetWidth * pixelRatio);
    canvas.height = Math.ceil(canvasContainer.offsetHeight * pixelRatio);

    ['contextmenu', 'gesturestart', 'gesturechange', 'gestureend'].forEach((event) => {
        document.addEventListener(event, (e) => { e.preventDefault(); }, true);
    });

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
        'selection.changed', 'tool.coordSpace', 'edit.apply'
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
};

main();
