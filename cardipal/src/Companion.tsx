import { useRef, useEffect } from 'react';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import { PhysicalPosition } from '@tauri-apps/api/dpi';
import { emit } from '@tauri-apps/api/event';

export function Companion() {
  const state = useRef({
    mode: 'idle' as 'idle' | 'dragging' | 'gliding',
    pointerDownId: null as number | null,
    wasDragged: false,
    
    startPointer: { x: 0, y: 0 },
    pos: { x: 0, y: 0 }, 
    bounds: { x: -99999, y: -99999, w: 999999, h: 999999 },
    size: { w: 100, h: 100 }, 
    scaleFactor: 1,
    
    velocity: { x: 0, y: 0 }, 
    history: [] as { x: number, y: number, time: number }[],
    lastSyncPos: { x: -1, y: -1 },
    lastGlideTime: 0,
    
    ipcInFlight: false, 
  });

  const frameId = useRef<number | null>(null);
  const reducedMotion = useRef(false);

  useEffect(() => {
    reducedMotion.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    return () => {
      if (frameId.current !== null) {
        cancelAnimationFrame(frameId.current);
        frameId.current = null;
      }
    };
  }, []);

  const clamp = (pos: { x: number; y: number }, bounds: { x: number; y: number; w: number; h: number }, size: { w: number; h: number }) => {
    let { x, y } = pos;
    let hitX = false;
    let hitY = false;

    if (x < bounds.x) { x = bounds.x; hitX = true; }
    else if (x + size.w > bounds.x + bounds.w) { x = bounds.x + bounds.w - size.w; hitX = true; }

    if (y < bounds.y) { y = bounds.y; hitY = true; }
    else if (y + size.h > bounds.y + bounds.h) { y = bounds.y + bounds.h - size.h; hitY = true; }

    return { x, y, hitX, hitY };
  };

  const renderLoop = () => {
    const s = state.current;

    if (s.mode === 'idle') {
      frameId.current = null;
      return;
    }

    if (s.mode === 'gliding') {
      const now = performance.now();
      const dt = Math.max(now - s.lastGlideTime, 1);
      s.lastGlideTime = now;

      const friction = Math.pow(0.996, dt);
      s.velocity.x *= friction;
      s.velocity.y *= friction;

      if (Math.abs(s.velocity.x) < 0.05 && Math.abs(s.velocity.y) < 0.05) {
        s.mode = 'idle';
        frameId.current = null;
        return;
      }

      s.pos.x += s.velocity.x * dt;
      s.pos.y += s.velocity.y * dt;

      const clamped = clamp(s.pos, s.bounds, s.size);
      s.pos.x = clamped.x;
      s.pos.y = clamped.y;

      if (clamped.hitX) s.velocity.x *= -0.4;
      if (clamped.hitY) s.velocity.y *= -0.4;
    }

    const targetX = Math.round(s.pos.x);
    const targetY = Math.round(s.pos.y);

    if (!s.ipcInFlight && (targetX !== s.lastSyncPos.x || targetY !== s.lastSyncPos.y)) {
      s.lastSyncPos = { x: targetX, y: targetY };
      s.ipcInFlight = true;
      
      getCurrentWindow().setPosition(new PhysicalPosition(targetX, targetY))
        .catch((error) => {
          console.error('Companion position failed:', error);
        })
        .finally(() => { 
           s.ipcInFlight = false; 
        });
    }

    frameId.current = requestAnimationFrame(renderLoop);
  };

  const handlePointerDown = async (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    
    if (frameId.current !== null) {
      cancelAnimationFrame(frameId.current);
      frameId.current = null;
    }

    const s = state.current;
    const pointerId = e.pointerId;
    s.pointerDownId = pointerId;
    s.mode = 'idle';
    s.wasDragged = false;
    
    s.startPointer = { x: e.screenX, y: e.screenY };
    s.history = [{ x: e.screenX, y: e.screenY, time: performance.now() }];
    s.velocity = { x: 0, y: 0 };

    e.currentTarget.setPointerCapture(pointerId);

    try {
      const win = getCurrentWindow();
      const [pos, size, monitor] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        currentMonitor(),
      ]);

      if (s.pointerDownId !== pointerId) return;
      if (!monitor) throw new Error('No active monitor');

      s.pos = { x: pos.x, y: pos.y };
      s.size = { w: size.width, h: size.height };
      s.scaleFactor = monitor.scaleFactor;
      
      const wa = (monitor as any).workArea || monitor;
      const workPos = wa.position || monitor.position;
      const workSize = wa.size || monitor.size;
      s.bounds = {
        x: workPos.x,
        y: workPos.y,
        w: workSize.width,
        h: workSize.height,
      };
      
      s.mode = 'dragging';
      
      if (frameId.current === null) {
        frameId.current = requestAnimationFrame(renderLoop);
      }
    } catch (error) {
      s.pointerDownId = null;
      console.error('Cannot start companion drag:', error);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = state.current;
    if (s.pointerDownId !== e.pointerId) return;

    const dxTotal = e.screenX - s.startPointer.x;
    const dyTotal = e.screenY - s.startPointer.y;
    
    if (!s.wasDragged && (Math.abs(dxTotal) > 3 || Math.abs(dyTotal) > 3)) {
      s.wasDragged = true;
    }

    if (s.mode !== 'dragging') return;

    const now = performance.now();
    s.history.push({ x: e.screenX, y: e.screenY, time: now });
    if (s.history.length > 8) s.history.shift(); 

    const last = s.history[s.history.length - 2] || s.history[0];
    const dxLogical = e.screenX - last.x;
    const dyLogical = e.screenY - last.y;

    s.pos.x += dxLogical * s.scaleFactor;
    s.pos.y += dyLogical * s.scaleFactor;

    const clamped = clamp(s.pos, s.bounds, s.size);
    s.pos.x = clamped.x;
    s.pos.y = clamped.y;
  };

  const endDrag = (shouldGlide: boolean) => {
    const s = state.current;
    s.pointerDownId = null;

    if (!shouldGlide || reducedMotion.current || !s.wasDragged) {
      s.mode = 'idle';
      return;
    }

    const now = performance.now();
    const validHistory = s.history.filter(h => now - h.time < 150);

    if (validHistory.length >= 2) {
      const oldest = validHistory[0];
      const newest = validHistory[validHistory.length - 1];
      const dt = Math.max(newest.time - oldest.time, 1);

      s.velocity.x = ((newest.x - oldest.x) * s.scaleFactor) / dt;
      s.velocity.y = ((newest.y - oldest.y) * s.scaleFactor) / dt;
    } else {
      s.velocity.x = 0;
      s.velocity.y = 0;
    }

    if (Math.abs(s.velocity.x) > 0.05 || Math.abs(s.velocity.y) > 0.05) {
      s.mode = 'gliding';
      s.lastGlideTime = now;
      if (frameId.current === null) {
        frameId.current = requestAnimationFrame(renderLoop);
      }
    } else {
      s.mode = 'idle';
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (state.current.pointerDownId === e.pointerId) {
      endDrag(true);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (state.current.pointerDownId === e.pointerId) {
      endDrag(false);
    }
  };

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (state.current.wasDragged && e.detail !== 0) {
      state.current.wasDragged = false;
      return;
    }
    state.current.wasDragged = false;
    
    try {
      await emit('summon-cardipal');
    } catch (err) {
      console.error('Failed to emit summon:', err);
    }
  };

  return (
    <button
      type="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onClick={handleClick}
      aria-label="Summon PromptPal"
      style={{
        width: '100%',
        height: '100%',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none',
        background: 'transparent',
        border: 'none',
        padding: 0
      }}
    >
      <img 
        src="/launcher.png"
        alt="PromptPal Launcher"
        draggable={false}
        style={{
          width: '60px',
          height: '60px',
          borderRadius: '50%',
          objectFit: 'cover',
          filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.2))',
          pointerEvents: 'none'
        }} 
      />
    </button>
  );
}