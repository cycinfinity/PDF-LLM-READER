import { Loader2 } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';

interface RenderTaskLike {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfViewerProps {
  pdfDoc: PDFDocumentProxy | null;
  pageNumber: number;
  zoom: number;
  fitWidth: boolean;
  onZoomChange: (zoom: number) => void;
}

export function PdfViewer({ pdfDoc, pageNumber, zoom, fitWidth, onZoomChange }: PdfViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderedPage, setRenderedPage] = useState(0);
  const effectiveScaleRef = useRef(1);
  const onZoomChangeRef = useRef(onZoomChange);
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());

  useEffect(() => {
    onZoomChangeRef.current = onZoomChange;
  }, [onZoomChange]);

  // Two-finger trackpad pinch: browsers expose it as wheel + ctrlKey. Attach a
  // non-passive native listener so the browser's own page zoom is suppressed and
  // only the PDF canvas is scaled (the chat sidebar stays untouched).
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.004);
      onZoomChangeRef.current(effectiveScaleRef.current * factor);
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale: effectiveScaleRef.current,
      };
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (!pinch || pointersRef.current.size !== 2) return;
    const [a, b] = [...pointersRef.current.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch.distance <= 0) return;
    event.preventDefault();
    onZoomChangeRef.current(pinch.scale * (distance / pinch.distance));
  };

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
  };

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const updateWidth = () => {
      const width = element.clientWidth;
      if (width > 0) setContainerWidth(width);
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdfDoc) return;
    if (containerWidth <= 0) return;

    let cancelled = false;
    let task: RenderTaskLike | null = null;
    setRendering(true);
    setRenderError(null);

    void (async () => {
      try {
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled) return;

        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(240, containerWidth - 48);
        const effectiveScale = fitWidth ? availableWidth / baseViewport.width : zoom;
        effectiveScaleRef.current = effectiveScale;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: effectiveScale * dpr });

        const canvas = canvasRef.current;
        if (!canvas) return;

        canvas.width = Math.max(1, Math.floor(viewport.width));
        canvas.height = Math.max(1, Math.floor(viewport.height));
        canvas.style.width = `${Math.max(1, Math.floor(effectiveScale * baseViewport.width))}px`;
        canvas.style.height = `${Math.max(1, Math.floor(effectiveScale * baseViewport.height))}px`;

        task = page.render({ canvas, viewport }) as unknown as RenderTaskLike;
        await task.promise;
        if (cancelled) return;

        setRenderedPage(pageNumber);
        setRendering(false);
        scrollRef.current?.scrollTo({ top: 0 });
      } catch (error) {
        if (cancelled) return;
        if ((error as { name?: string }).name === 'RenderingCancelledException') return;
        setRenderError(error instanceof Error ? error.message : String(error));
        setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        // ignore cancellation races
      }
    };
  }, [pdfDoc, pageNumber, zoom, fitWidth, containerWidth]);

  return (
    <div
      ref={scrollRef}
      data-testid="pdf-scroll"
      data-rendered-page={renderedPage}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      className="relative min-h-0 flex-1 overflow-auto bg-slate-200/70 p-6"
    >
      {renderError ? (
        <div className="mx-auto mt-10 max-w-md rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
          渲染失败：{renderError}
        </div>
      ) : (
        <div className="flex min-h-full justify-center">
          <div className="relative" style={{ touchAction: 'none' }}>
            <canvas ref={canvasRef} data-testid="pdf-canvas" className="pdf-canvas block" />
            {rendering && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/40">
                <Loader2 className="animate-spin text-slate-500" size={28} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
