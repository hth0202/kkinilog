import { useDialog } from '../../hooks/useDialog';

export default function BottomSheet({ onClose, children, className = '' }) {
  const dialogRef = useDialog(onClose);

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-ink/[0.28]"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className={`fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl bg-surface shadow-sheet safe-bottom ${className}`}
        role="dialog"
        aria-modal="true"
        aria-label="컨디션 기록"
        tabIndex={-1}
      >
        <div className="mx-auto mt-3 mb-4 h-1 w-10 rounded-full bg-line" />
        {children}
      </div>
    </>
  );
}
