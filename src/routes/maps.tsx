import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  buildImportedMap,
  CRS_OPTIONS,
  parseMapFile,
  type CrsId,
  type ParsedImport,
} from "@/lib/mine/importMap";
import {
  featureCount,
  LAYER_KINDS,
  LAYER_LABEL,
  useMineMaps,
  type LayerKind,
  type MapLayer,
  type MineMapDoc,
} from "@/lib/mine/mapStore";
import { reprojectFC } from "@/lib/mine/importMap";

const MineMapView = lazy(() => import("@/components/mine/MineMapView"));

export const Route = createFileRoute("/maps")({
  head: () => ({
    meta: [
      { title: "My Mine Maps — Import QGIS Maps into MINEGUARD" },
      {
        name: "description",
        content:
          "Import QGIS mine maps into MINEGUARD as GeoJSON, KML or CSV, reproject them to WGS84, manage layers and set the active map for live vehicle tracking.",
      },
      { property: "og:title", content: "MINEGUARD — My Mine Maps" },
      {
        property: "og:description",
        content: "Upload, preview, reproject and activate QGIS-exported mine maps for the MINEGUARD safety platform.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: MapsPage,
});

function MapsPage() {
  const store = useMineMaps();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [parsed, setParsed] = useState<ParsedImport | null>(null);
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [crs, setCrs] = useState<CrsId>("EPSG:4326");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  const preview: MineMapDoc | null = useMemo(() => {
    if (!layers.length) return null;
    return {
      id: "preview",
      name: name || "Preview",
      createdAt: Date.now(),
      source: "IMPORT",
      sourceCrs: crs,
      layers: layers.map((l) => ({ ...l, fc: reprojectFC(l.fc, crs) })),
    };
  }, [layers, crs, name]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      const res = await parseMapFile(file);
      setParsed(res);
      setLayers(res.layers);
      setCrs(res.suggestedCrs);
      setName(file.name.replace(/\.[^.]+$/, ""));
    } catch (e) {
      setParsed(null);
      setLayers([]);
      setError(e instanceof Error ? e.message : "Could not read this file.");
    }
  };

  const confirmImport = () => {
    if (!layers.length) return;
    const doc = buildImportedMap(name.trim() || "Imported map", layers, crs);
    store.saveMap(doc, true);
    setParsed(null);
    setLayers([]);
    setName("");
  };

  return (
    <main className="min-h-screen bg-background p-3 text-foreground">
      <header className="panel-frame mb-3 flex flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div>
          <p className="font-display text-xl font-bold leading-none tracking-[0.22em] text-primary">MINEGUARD</p>
          <h1 className="tech-label">My mine maps · QGIS import</h1>
        </div>
        <nav className="flex gap-2 font-mono text-xs uppercase">
          <Link to="/" className="rounded-sm border border-panel-line px-3 py-1 hover:text-primary">
            Command center
          </Link>
          <Link to="/live" className="rounded-sm border border-panel-line px-3 py-1 hover:text-primary">
            Live vehicle
          </Link>
        </nav>
      </header>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        {/* ----------------------------------------------------- import */}
        <section className="panel-frame flex flex-col gap-3 p-3">
          <div>
            <h2 className="font-display text-sm font-semibold uppercase tracking-[0.18em]">Import mine map</h2>
            <p className="mt-1 font-mono text-[11px] leading-5 text-muted-foreground">
              Export from QGIS with Layer → Export → Save Features As… → GeoJSON (EPSG:4326 recommended), then upload
              it here. KML and coordinate CSV files are also supported. Shapefile and GeoPackage are imported through
              the same QGIS export step.
            </p>
          </div>

          <input
            type="file"
            accept=".geojson,.json,.kml,.xml,.csv,.gpkg,.zip,.shp"
            onChange={(e) => void onFile(e.target.files?.[0])}
            className="w-full rounded-sm border border-panel-line bg-transparent p-2 font-mono text-[11px] file:mr-2 file:rounded-sm file:border-0 file:bg-primary file:px-2 file:py-1 file:font-mono file:text-[11px] file:uppercase file:text-primary-foreground"
          />

          {error && <p className="rounded-sm border border-risk-high/60 bg-risk-high/10 p-2 font-mono text-[11px] text-risk-high">{error}</p>}
          {parsed?.warning && (
            <p className="rounded-sm border border-risk-caution/60 bg-risk-caution/10 p-2 font-mono text-[11px] text-risk-caution">
              {parsed.warning}
            </p>
          )}

          {!!layers.length && (
            <>
              <label className="block font-mono text-[11px] uppercase text-muted-foreground">
                Map name
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 w-full rounded-sm border border-panel-line bg-transparent px-2 py-1 font-mono text-xs text-foreground"
                />
              </label>

              <label className="block font-mono text-[11px] uppercase text-muted-foreground">
                Coordinate reference system of the file
                <select
                  value={crs}
                  onChange={(e) => setCrs(e.target.value as CrsId)}
                  className="mt-1 w-full rounded-sm border border-panel-line bg-background px-2 py-1 font-mono text-[11px] text-foreground"
                >
                  {CRS_OPTIONS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="font-mono text-[10px] text-muted-foreground">
                MINEGUARD reprojects everything to WGS84 so imported geometry and live GNSS positions share one CRS.
              </p>

              <div>
                <p className="tech-label mb-1">Detected layers ({layers.length})</p>
                <div className="max-h-56 space-y-1 overflow-auto">
                  {layers.map((l, i) => (
                    <div key={l.id} className="flex items-center gap-2 rounded-sm border border-panel-line px-2 py-1">
                      <span className="flex-1 truncate font-mono text-[11px]">{l.name}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{l.fc.features.length}</span>
                      <select
                        value={l.kind}
                        onChange={(e) => {
                          const kind = e.target.value as LayerKind;
                          setLayers((prev) => prev.map((x, j) => (j === i ? { ...x, kind } : x)));
                        }}
                        className="rounded-sm border border-panel-line bg-background px-1 py-0.5 font-mono text-[10px]"
                      >
                        {LAYER_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {LAYER_LABEL[k]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <button
                onClick={confirmImport}
                className="rounded-sm bg-primary px-3 py-2 font-display text-xs font-semibold uppercase tracking-widest text-primary-foreground"
              >
                Import & save map
              </button>
            </>
          )}

          <div className="mt-2 border-t border-panel-line pt-3">
            <button
              onClick={() => store.loadSample()}
              className="w-full rounded-sm border border-primary px-3 py-2 font-display text-xs font-semibold uppercase tracking-widest text-primary"
            >
              Load sample Bailadila map
            </button>
            <p className="mt-1 font-mono text-[10px] leading-4 text-muted-foreground">
              Simulation / prototype — a realistic fictional open-cast layout inspired by Bailadila (pit, benches,
              highwall, haul roads, switchbacks, blind curves, loading &amp; dumping zones, restricted and risk zones,
              entrance, checkpoints, RSUs). Not an official NMDC map.
            </p>
          </div>
        </section>

        {/* -------------------------------------------- preview + library */}
        <section className="flex flex-col gap-3">
          <div className="panel-frame relative h-[52vh] min-h-[320px] overflow-hidden">
            <div className="absolute left-2 top-2 z-[500] rounded-sm border border-panel-line bg-background/85 px-2 py-1 font-mono text-[11px] backdrop-blur-sm">
              {preview ? `Preview · ${preview.name}` : store.active ? `Active map · ${store.active.name}` : "No map loaded"}
            </div>
            {mounted && (
              <Suspense fallback={<div className="grid h-full place-items-center font-mono text-xs">LOADING MAP…</div>}>
                <MineMapView doc={preview ?? store.active} vehicles={[]} follow={false} cmd={null} />
              </Suspense>
            )}
          </div>

          <div className="panel-frame p-3">
            <h2 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.18em]">My mine maps</h2>
            {!store.maps.length && (
              <p className="font-mono text-[11px] text-muted-foreground">
                No maps yet — import a QGIS export or load the sample Bailadila map.
              </p>
            )}
            <div className="space-y-1.5">
              {store.maps.map((m) => (
                <div
                  key={m.id}
                  className={`flex flex-wrap items-center gap-2 rounded-sm border px-2 py-1.5 ${
                    m.id === store.activeId ? "border-primary bg-primary/5" : "border-panel-line"
                  }`}
                >
                  {renaming === m.id ? (
                    <input
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onBlur={() => {
                        store.renameMap(m.id, renameText.trim() || m.name);
                        setRenaming(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      className="flex-1 rounded-sm border border-panel-line bg-transparent px-1 font-mono text-xs"
                    />
                  ) : (
                    <span className="flex-1 truncate font-mono text-xs">{m.name}</span>
                  )}
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {m.layers.length} layers · {featureCount(m)} features · {m.sourceCrs}
                  </span>
                  <div className="flex gap-1 font-mono text-[10px] uppercase">
                    <button onClick={() => store.setActive(m.id)} className="rounded-sm border border-panel-line px-2 py-0.5 hover:text-primary">
                      {m.id === store.activeId ? "Active" : "Set active"}
                    </button>
                    <Link
                      to="/live"
                      onClick={() => store.setActive(m.id)}
                      className="rounded-sm border border-panel-line px-2 py-0.5 hover:text-primary"
                    >
                      Open
                    </Link>
                    <button
                      onClick={() => {
                        setRenaming(m.id);
                        setRenameText(m.name);
                      }}
                      className="rounded-sm border border-panel-line px-2 py-0.5 hover:text-primary"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => store.deleteMap(m.id)}
                      className="rounded-sm border border-panel-line px-2 py-0.5 text-risk-high hover:border-risk-high"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
