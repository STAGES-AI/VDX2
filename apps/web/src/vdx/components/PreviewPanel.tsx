/** Latest render playback (or a placeholder until one exists). */
export function PreviewPanel({ url }: { url: string | null }) {
  return (
    <div className="flex h-full items-center justify-center bg-black/90 p-3">
      {url ? (
        // key forces a reload when a newer render lands
        <video key={url} src={url} controls className="max-h-full max-w-full rounded-md" />
      ) : (
        <div className="text-center text-sm text-white/50">
          <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-full border border-white/20">
            <svg viewBox="0 0 24 24" className="size-6 fill-white/50">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <p>No render yet</p>
          <p className="mt-1 text-xs text-white/30">Renders appear here when a job finishes</p>
        </div>
      )}
    </div>
  );
}
