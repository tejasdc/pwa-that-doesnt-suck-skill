# React + imperative animation

*Load before writing any animation code that mutates DOM directly (piece movement, canvas overlay, custom transitions, physics simulation, WebGL). This encodes the ownership isolation pattern that prevents `NotFoundError: removeChild` crashes and the belt-and-suspenders error boundary that recovers when the pattern still fails.*

## The rule

**React and imperative animation code never share DOM nodes.**

If your animation code creates, moves, or destroys nodes directly (`appendChild`, `removeChild`, style writes, transform mutations), those nodes live INSIDE an opaque ref'd container that React never enumerates.

React renders the outer wrapper only. Every child under the ref is created, mutated, and destroyed EXCLUSIVELY by the imperative code. React reconciliation touches nothing under that ref.

## The failure mode without this rule

Symptom: the animation works on rounds 1-2, then on round 3 the whole component crashes with:
```
Uncaught NotFoundError: Failed to execute 'removeChild' on 'Node':
  The node to be removed is not a child of this node.
```

Root cause: React also owned the animated nodes (rendered them via `pieces.map(p => <Piece key={p.id} ... />)` under a ref). When React reconciled during a re-render, it tried to `removeChild` a node the imperative code had already detached (or moved to a different parent). React's internal fiber tree doesn't match the actual DOM anymore. Whole subtree unmounts.

Single writer per DOM node — the crash's root cause is eliminated by ownership discipline, not patched at the symptom.

## The pattern

```tsx
function AnimatedShelf() {
  // React OWNS: shell wrappers, static labels, buttons, data-attributes.
  // React state drives things React can safely reconcile — the wrapper's
  // data-animating flag, the caption, the puzzle-id attribute.
  const [index, setIndex] = useState(0);
  const [animating, setAnimating] = useState(false);

  // OPAQUE containers — React renders these once as empty divs. What lives
  // inside them is the animation code's sole responsibility.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const piecesLayerRef = useRef<HTMLDivElement | null>(null);

  // The imperative code's registry — maps entity id → the DOM node it owns.
  // React NEVER reads or writes this map.
  const pieceEls = useRef(new Map<string, HTMLSpanElement>());

  // Imperative mount / reset — runs when the container mounts (metrics land)
  // and on manual reset. Wipes all children, rebuilds fresh.
  useEffect(() => {
    const layer = piecesLayerRef.current;
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    pieceEls.current.clear();

    for (const piece of piecesForPosition(index)) {
      const el = createPieceEl(piece);
      layer.appendChild(el);
      pieceEls.current.set(piece.id, el);
    }
  }, [index]);

  // Imperative animation — reads the map, mutates styles directly.
  function walkTo(nextIndex: number) {
    setAnimating(true);
    const moves = computeMoves(index, nextIndex);
    for (const m of moves) {
      const el = pieceEls.current.get(m.pieceId);
      if (!el) continue;
      el.style.transform = `translate(${m.toX}px, ${m.toY}px)`;
    }
    setTimeout(() => {
      setIndex(nextIndex);
      setAnimating(false);
    }, DURATION_MS);
  }

  return (
    <div data-animating={animating}>
      <div className="caption">Puzzle #{index}</div>
      {/* stageRef and piecesLayerRef point at empty divs — React never
          enumerates their children. */}
      <div ref={stageRef} className="stage">
        <div ref={piecesLayerRef} className="pieces-layer" />
      </div>
    </div>
  );
}
```

Key points:
- React JSX for the wrapper, ref'd empty div for the animation surface.
- All DOM inside `piecesLayerRef.current` is created via `document.createElement()` (or `createPieceEl()` helper), appended imperatively, tracked in `pieceEls.current`.
- The animation function reads the map and writes styles. React never sees the mutations.
- `useEffect` on `[index]` for RESETS wipes and rebuilds — during a reset the imperative code owns the wipe, not React.

## Guard against reset during in-flight animation

```tsx
const animatingRef = useRef(false);
useEffect(() => { animatingRef.current = animating; }, [animating]);

useEffect(() => {
  const layer = piecesLayerRef.current;
  if (!layer) return;
  // If a walk is in-flight, don't yank the DOM out from under it.
  if (animatingRef.current) return;
  // ...wipe + rebuild
}, [index]);
```

The `useEffect` that resets can fire on any dep change; if a state update lands mid-animation the reset shouldn't blow up the walk. Bail early.

## Belt-and-suspenders: the error boundary

Even with ownership isolation, edge cases exist (fast-refresh during dev, browser quirks, third-party scripts touching the DOM). Wrap the surface in an error boundary that resets by bumping a key:

```tsx
class AnimatedShelfBoundary extends React.Component<
  { children: React.ReactNode },
  { resetKey: number }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { resetKey: 0 };
  }
  static getDerivedStateFromError() { return {}; }
  componentDidCatch(error: unknown) {
    console.error("AnimatedShelf error — resetting:", error);
    this.setState(prev => ({ resetKey: prev.resetKey + 1 }));
  }
  render() {
    return (
      <React.Fragment key={this.state.resetKey}>
        {this.props.children}
      </React.Fragment>
    );
  }
}
```

- `getDerivedStateFromError` returns `{}` (no state change from the throw itself).
- `componentDidCatch` bumps `resetKey`, forcing React to unmount and remount the children fresh.
- The reset IS the UX — no user-visible error state, no "something went wrong" screen. The child remounts, the animation re-initializes, the user sees a tiny flicker at worst.

Wire it in:
```tsx
<AnimatedShelfBoundary>
  <AnimatedShelf />
</AnimatedShelfBoundary>
```

## Effects that POST — depend on stable primitives, not fresh callbacks

A related failure mode: a `useEffect` that dispatches a command (POST, delete, kick off a job) MUST NOT depend on freshly-created callback references. React recreates callbacks on every parent render; the effect re-fires; the POST happens over and over; the parent re-renders because the response changed state; the effect fires again. Hidden request loop.

**Wrong:**
```tsx
function InvitePanel({ refresh, onAccept }: { refresh: () => void; onAccept: () => void }) {
  useEffect(() => {
    // refresh is a fresh function every parent render — effect re-fires forever.
    fetch("/api/invitations/mark-seen", { method: "POST" }).then(refresh);
  }, [refresh]); // <-- unstable dep
  // ...
}
```

**Right — depend on stable primitives:**
```tsx
function InvitePanel({ inviteId }: { inviteId: string }) {
  useEffect(() => {
    // inviteId is a primitive; changes only when the invitation actually changes.
    let cancelled = false;
    fetch(`/api/invitations/${inviteId}/mark-seen`, { method: "POST" }).then(() => {
      if (!cancelled) { /* update local state if needed */ }
    });
    return () => { cancelled = true; };
  }, [inviteId]);
  // ...
}
```

**Or lift the callback to a stable identity:**
```tsx
// Parent:
const refresh = useCallback(() => { /* ... */ }, [/* stable deps */]);
```

**Better yet:** don't put POSTs in effects at all. Effects are for synchronizing external state (subscriptions, timers, DOM). Commands go in event handlers or explicit imperative calls. If you're POSTing on mount, ask whether you actually need `useEffect` — often a plain function call inside a `useMemo` or a one-time ref works and doesn't have this failure mode at all.

**Detection:** any effect that POSTs / PUTs / DELETEs gets a code review question: "what's in the dependency array, and is each entry stable across parent renders?" If any dep is a callback or an object literal, refactor.

## When you don't need this pattern

If your animation is CSS-only (transitions, keyframes) and you're mutating className / style via React state — you're fine. React owns the DOM, the browser interpolates. This pattern is for **imperative DOM mutation** — GSAP-style, canvas-style, direct-appendChild-style.

## When you MIGHT need it but shouldn't reach for it

If a shipped React component library (Framer Motion, React Spring) does the animation for you, use it. This pattern is what you write when the animation is domain-specific enough that a library doesn't fit (chess pieces walking between positions, custom physics, WebGL-integrated layout).

## Framework-agnostic version

The invariant survives framework choice:
- **Vue:** use `v-html` or a template ref pointing at a `<div>` that has no v-for children.
- **Svelte:** use `bind:this` on an empty `<div>`; never spread reactive state as its children.
- **Solid:** ref an empty `<div>`; never place `<For>` or `<Show>` inside.
- **Vanilla:** the whole app is imperative; no isolation needed.

The rule: **one writer per DOM node.** Pick whether the writer is your framework OR your animation code. Never both.

## Sources

- Reference implementation: `src/main.tsx` `LandingPuzzleShelf` component (search for "OWNERSHIP MODEL" comment near line 96) and `LandingPuzzleShelfBoundary` class in the chess-with-friends project.
- The specific crash: a `NotFoundError: removeChild` regression labeled `pre-live-crash` in the reference project's commit history. Root-caused to the pieces layer being both `pieces.map(...)` in React AND `piecesLayerRef.current.appendChild(...)` in animation code.
