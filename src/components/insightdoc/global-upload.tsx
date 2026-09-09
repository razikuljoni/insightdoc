'use client';

/**
 * InsightDoc — Global Upload Manager
 * Window-level drag-and-drop: dropping PDFs anywhere in the app uploads them
 * to the active workspace. Renders (1) an animated full-screen drop overlay
 * while a drag is in flight and (2) a floating progress card while the batch
 * uploads. Shares validation rules with the inline UploadZone.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, CloudUpload, FileText, Loader2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/types';
import { validatePdfFiles, type FileValidationError } from '@/lib/file-validation';
import { uploadDocuments } from './api-client';
import { useAppStore } from './store';

type Phase = 'idle' | 'hovering' | 'uploading' | 'done';

interface GlobalUploadManagerProps {
  /** Disable while an inline zone is mid-upload to avoid double batches. */
  enabled?: boolean;
}

export function GlobalUploadManager({ enabled = true }: GlobalUploadManagerProps) {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const workspaces = useAppStore((s) => s.workspaces);
  const upsertDocument = useAppStore((s) => s.upsertDocument);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [batch, setBatch] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
  const [errors, setErrors] = useState<FileValidationError[]>([]);
  const dragDepth = useRef(0);
  const busyRef = useRef(false);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const workspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'workspace';

  const startUpload = useCallback(
    async (files: File[]) => {
      if (!activeWorkspaceId || files.length === 0 || busyRef.current) return;
      const { valid, errors: validationErrors } = validatePdfFiles(files);
      setErrors(validationErrors);
      if (valid.length === 0) {
        if (validationErrors.length > 0) {
          toast.error(validationErrors[0].error, {
            description: validationErrors[0].fileName,
          });
        }
        return;
      }

      busyRef.current = true;
      setBatch({ count: valid.length, bytes: valid.reduce((s, f) => s + f.size, 0) });
      setProgress(0);
      setPhase('uploading');
      try {
        const result = await uploadDocuments(activeWorkspaceId, valid, setProgress);
        result.documents.forEach(upsertDocument);
        const allErrors = [...validationErrors, ...result.errors];
        setErrors(allErrors);
        if (result.errors.length > 0) {
          toast.warning(`Uploaded ${result.documents.length}/${valid.length} — some files were rejected`);
        } else {
          toast.success(
            `${result.documents.length} document${result.documents.length === 1 ? '' : 's'} queued for ingestion`,
            { description: 'Vector indexing started — track progress in Documents.' },
          );
        }
      } catch (error) {
        setErrors((prev) => [
          ...prev,
          { fileName: 'Batch', error: error instanceof Error ? error.message : 'Upload failed' },
        ]);
        toast.error('Upload failed', {
          description: error instanceof Error ? error.message : undefined,
        });
      } finally {
        busyRef.current = false;
        setPhase('done');
        // Return to idle after the completion flash
        window.setTimeout(() => {
          if (phaseRef.current === 'done') setPhase('idle');
        }, 1600);
      }
    },
    [activeWorkspaceId, upsertDocument],
  );

  useEffect(() => {
    if (!enabled) return;

    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e) || !useAppStore.getState().activeWorkspaceId) return;
      e.preventDefault();
      dragDepth.current += 1;
      if (phaseRef.current === 'idle' || phaseRef.current === 'done') setPhase('hovering');
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0 && phaseRef.current === 'hovering') setPhase('idle');
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (phaseRef.current === 'hovering') setPhase('idle');
      if (dropped.length > 0) void startUpload(dropped);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enabled, startUpload]);

  const visible = phase !== 'idle';
  const hovering = phase === 'hovering';

  return (
    <>
      {/* Full-screen drop overlay */}
      <AnimatePresence>
        {hovering && (
          <motion.div
            key="drop-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
            role="status"
            aria-label="Drop files to upload"
          >
            <motion.div
              initial={{ scale: 0.94, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 4 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
              className={cn(
                'flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border-2 border-dashed border-primary/60 bg-card/90 p-10 text-center shadow-2xl shadow-primary/10',
              )}
            >
              <motion.div
                animate={{ y: [0, -7, 0] }}
                transition={{ repeat: Infinity, duration: 1.4, ease: 'easeInOut' }}
                className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/15"
              >
                <CloudUpload className="h-8 w-8 text-primary" />
              </motion.div>
              <div>
                <p className="text-lg font-semibold">Release to upload</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  PDFs land in <span className="font-medium text-foreground">{workspaceName}</span> and
                  enter the ingestion pipeline automatically.
                </p>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <FileText className="h-3.5 w-3.5" /> PDF only · max 50MB each · multi-file
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating batch progress card */}
      <AnimatePresence>
        {visible && !hovering && (
          <motion.div
            key="upload-card"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            className="fixed bottom-4 right-4 z-[80] w-80 overflow-hidden rounded-xl border bg-card shadow-xl shadow-black/10"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2.5 border-b px-3.5 py-2.5">
              <span
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-lg',
                  phase === 'done' ? 'bg-emerald-500/15' : 'bg-primary/10',
                )}
              >
                {phase === 'done' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold">
                  {phase === 'done'
                    ? `Uploaded ${batch.count} file${batch.count === 1 ? '' : 's'}`
                    : `Uploading ${batch.count} file${batch.count === 1 ? '' : 's'}…`}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  {formatBytes(batch.bytes)} → {workspaceName}
                </p>
              </div>
              {phase === 'done' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => setPhase('idle')}
                  aria-label="Dismiss upload status"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="px-3.5 pb-3.5 pt-3">
              <Progress value={phase === 'done' ? 100 : progress} className="h-1.5" />
              <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">
                {phase === 'done' ? '100% · handed to ingestion queue' : `${progress}%`}
              </p>
            </div>
            {errors.length > 0 && (
              <div className="space-y-1 border-t bg-destructive/5 px-3.5 py-2">
                {errors.slice(0, 3).map((err, i) => (
                  <p key={`gerr-${i}`} className="flex items-center gap-1.5 text-[11px] text-destructive">
                    <TriangleAlert className="h-3 w-3 shrink-0" />
                    <span className="truncate font-medium">{err.fileName}</span>
                    <span className="truncate text-muted-foreground">— {err.error}</span>
                  </p>
                ))}
                {errors.length > 3 && (
                  <p className="text-[10px] text-muted-foreground">+{errors.length - 3} more rejected</p>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
