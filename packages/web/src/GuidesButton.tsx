/** "Guides (G)": the viewer's switch for layout guides, on the canvas and in play mode. The caller styles it. */
export function GuidesButton({ pressed, onToggle, className }: { pressed: boolean; onToggle: () => void; className: string }) {
  return (
    <button type="button" aria-pressed={pressed} title="Afficher les guides de mise en page (G)" className={className} onClick={onToggle}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 3v18" />
        <path d="M15 3v18" />
      </svg>
      Guides (G)
    </button>
  );
}
