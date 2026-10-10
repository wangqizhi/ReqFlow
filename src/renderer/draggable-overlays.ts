// Shared pointer-based movement for every custom modal, including nested dialogs.
const surfaces = '.dialog, .help-panel, .fb';
const handles = '.dialog-head, .help-header, .fb-tree-head, .fb-viewer-head, .dialog > h3';
export function installDraggableOverlays() {
  const positions = new WeakMap<HTMLElement, { x: number; y: number }>();
  let gesture: { inside: boolean } | undefined;
  let active: { surface: HTMLElement; handle: HTMLElement; id: number; px: number; py: number; x: number; y: number; rect: DOMRect } | undefined;
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  function finish() { active?.surface.classList.remove('overlay-dragging'); active = undefined; }
  document.addEventListener('pointerdown', e => {
    gesture = e.target instanceof Element ? { inside: !!e.target.closest(surfaces) } : undefined;
    if (e.button !== 0 || !(e.target instanceof Element) || e.target.closest('button,input,textarea,select,a,summary,[role=button]')) return;
    const handle = e.target.closest<HTMLElement>(handles);
    const surface = handle?.closest<HTMLElement>(surfaces);
    if (!handle || !surface) return;
    const p = positions.get(surface) || { x: 0, y: 0 };
    active = { surface, handle, id: e.pointerId, px: e.clientX, py: e.clientY, ...p, rect: surface.getBoundingClientRect() };
    surface.classList.add('overlay-dragging');
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, true);
  // A press starting in a dialog and ending on its backdrop produces a click on
  // their common ancestor. It is not an intentional outside click.
  document.addEventListener('click', e => {
    if (e.detail === 0) return; // keyboard/programmatic activation is unaffected
    const down = gesture; gesture = undefined;
    if (down?.inside && e.target instanceof Element && e.target.matches('.overlay, .fb-overlay')) {
      e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  document.addEventListener('pointermove', e => {
    if (!active || active.id !== e.pointerId) return;
    const a = active;
    const dx = clamp(e.clientX - a.px, -a.rect.left, Math.max(-a.rect.left, innerWidth - a.rect.right));
    const dy = clamp(e.clientY - a.py, -a.rect.top, Math.max(-a.rect.top, innerHeight - a.rect.bottom));
    const p = { x: a.x + dx, y: a.y + dy };
    positions.set(a.surface, p);
    a.surface.style.translate = `${p.x}px ${p.y}px`;
  });
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  document.addEventListener('lostpointercapture', finish);
  window.addEventListener('blur', () => { finish(); gesture = undefined; });
  window.addEventListener('resize', () => {
    finish();
    document.querySelectorAll<HTMLElement>(surfaces).forEach(surface => {
      const p = positions.get(surface); if (!p) return;
      const r = surface.getBoundingClientRect();
      p.x += clamp(0, -r.left, Math.max(-r.left, innerWidth - r.right));
      p.y += clamp(0, -r.top, Math.max(-r.top, innerHeight - r.bottom));
      surface.style.translate = `${p.x}px ${p.y}px`;
    });
  });
}
