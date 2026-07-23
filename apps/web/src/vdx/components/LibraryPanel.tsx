import { fmtBytes, fmtClock, resolveMediaUrl } from "../lib";
import type { AssetKind, LibraryAsset, LibraryResponse } from "../types";
import { EntityBadge, KindIcon } from "./badges";

const KIND_ORDER: AssetKind[] = ["image", "video", "audio", "document"];

const KIND_LABEL: Record<AssetKind, string> = {
  image: "Images",
  video: "Video",
  audio: "Audio",
  document: "Documents",
};

function AssetRow({ asset }: { asset: LibraryAsset }) {
  const detail = [
    fmtBytes(asset.sizeBytes),
    asset.durationSec != null ? fmtClock(asset.durationSec) : null,
    asset.purpose !== "reference" ? asset.purpose : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/60 px-2 py-1.5">
      <KindIcon kind={asset.kind} className="size-4 shrink-0 fill-current text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs" title={asset.name}>
        {asset.name}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{detail}</span>
    </div>
  );
}

/** Library tab: assets grouped by kind, then the entity bank. */
export function LibraryPanel({ library }: { library: LibraryResponse | null }) {
  if (!library) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        The library fills up as you upload references and the director generates shots.
      </div>
    );
  }

  const { assets, entities } = library;

  return (
    <div className="h-full space-y-4 overflow-y-auto p-3">
      {assets.length === 0 && entities.length === 0 ? (
        <p className="mt-8 px-4 text-center text-sm text-muted-foreground">
          Nothing here yet — drop files anywhere or use the paperclip in chat.
        </p>
      ) : null}

      {KIND_ORDER.map((kind) => {
        const group = assets.filter((a) => a.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind}>
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {KIND_LABEL[kind]} <span className="opacity-60">({group.length})</span>
            </h3>
            {kind === "image" ? (
              <div className="grid grid-cols-3 gap-1.5">
                {group.map((asset) => (
                  <figure
                    key={asset.assetId}
                    className="overflow-hidden rounded-md border border-border/60 bg-card/60"
                    title={`${asset.name} · ${fmtBytes(asset.sizeBytes)}`}
                  >
                    <img
                      src={resolveMediaUrl(asset.url)}
                      alt={asset.name}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                    <figcaption className="truncate px-1 py-0.5 text-[10px] text-muted-foreground">
                      {asset.name}
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                {group.map((asset) => (
                  <AssetRow key={asset.assetId} asset={asset} />
                ))}
              </div>
            )}
          </section>
        );
      })}

      {entities.length > 0 ? (
        <section>
          <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Entities <span className="opacity-60">({entities.length})</span>
          </h3>
          <div className="space-y-1.5">
            {entities.map((entity) => (
              <div key={entity.id} className="rounded-md border border-border/60 bg-card/60 p-2">
                <div className="flex items-center gap-2">
                  <EntityBadge type={entity.type} />
                  <span className="min-w-0 truncate text-xs font-medium" title={entity.name}>
                    {entity.name}
                  </span>
                </div>
                {entity.description ? (
                  <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                    {entity.description}
                  </p>
                ) : null}
                {entity.referenceImageUrls.length > 0 ? (
                  <div className="mt-1.5 flex gap-1">
                    {entity.referenceImageUrls.slice(0, 5).map((url) => (
                      <img
                        key={url}
                        src={resolveMediaUrl(url)}
                        alt=""
                        loading="lazy"
                        className="size-9 rounded object-cover"
                      />
                    ))}
                  </div>
                ) : null}
                {entity.voiceUrls.length > 0 ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {entity.voiceUrls.length} voice {entity.voiceUrls.length === 1 ? "sample" : "samples"}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
