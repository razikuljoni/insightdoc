'use client';

/**
 * InsightDoc — Drag & Drop Upload Zone (spec §2.2)
 * Client-side validation: PDF only, max 50MB per file, multi-file, XHR progress.
 */
import { useCallback, useRef, useState } from 'react';
import { CloudUpload, FileText, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/types';
import { validatePdfFiles } from '@/lib/file-validation';
import { uploadDocuments } from './api-client';
import { useAppStore } from './store';

interface UploadZoneProps {
  compact?: boolean;
}

export function UploadZone({ compact = false }: UploadZoneProps) {
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const upsertDocument = useAppStore((s) => s.upsertDocument);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [errors, setErrors] = useState<Array<{ fileName: string; error: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const startUpload = useCallback(
    async (files: File[]) => {
      if (!activeWorkspaceId || files.length === 0) return;
      setErrors([]);

      const { valid, errors: validationErrors } = validatePdfFiles(files);
      if (validationErrors.length > 0) setErrors(validationErrors);
      if (valid.length === 0) return;

      setUploading(true);
      setProgress(0);
      try {
        const result = await uploadDocuments(activeWorkspaceId, valid, setProgress);
        result.documents.forEach(upsertDocument);
        if (result.errors.length > 0) setErrors((prev) => [...prev, ...result.errors]);
      } catch (error) {
        setErrors([{ fileName: 'Upload', error: error instanceof Error ? error.message : 'Upload failed' }]);
      } finally {
        setUploading(false);
      }
    },
    [activeWorkspaceId, upsertDocument],
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void startUpload(Array.from(e.dataTransfer.files));
  };

  const disabled = !activeWorkspaceId || uploading;

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload PDF documents"
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled) inputRef.current?.click();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition',
          compact ? 'p-4' : 'p-8',
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-accent/40',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          className="hidden"
          onChange={(e) => {
            void startUpload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
        {uploading ? (
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        ) : (
          <CloudUpload className={cn('text-primary/70', compact ? 'h-5 w-5' : 'h-8 w-8')} />
        )}
        {!compact && (
          <>
            <p className="text-sm font-medium">
              {uploading ? `Uploading… ${progress}%` : 'Drop PDFs here or click to browse'}
            </p>
            <p className="text-xs text-muted-foreground">Multi-file · max 50MB each · text-based PDFs</p>
          </>
        )}
        {compact && (
          <p className="text-xs font-medium">
            {uploading ? `Uploading… ${progress}%` : 'Upload PDFs'}
          </p>
        )}
      </div>

      {uploading && <Progress value={progress} className="mt-2 h-1.5" />}

      {errors.length > 0 && (
        <div className="mt-2 space-y-1">
          {errors.map((err, i) => (
            <div
              key={`err-${i}`}
              className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs"
            >
              <X className="h-3 w-3 shrink-0 text-destructive" />
              <span className="truncate font-medium">{err.fileName}</span>
              <span className="truncate text-muted-foreground">{err.error}</span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto h-4 w-4 shrink-0"
                onClick={() => setErrors((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Dismiss error"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
