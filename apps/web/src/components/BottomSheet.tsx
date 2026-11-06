import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/ui/drawer';

/**
 * The app's sheet: shadcn's Drawer from the bottom, shown while mounted. A swipe down, the close
 * button, Escape and a tap outside all call `onClose`; focus stays inside while it's open.
 *
 * Focus starts on the sheet itself, so a form doesn't pop the phone keyboard on open;
 * `focusFirstField` starts it on the first field instead (a search box).
 */
export function BottomSheet({
  title,
  description,
  onClose,
  focusFirstField = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  focusFirstField?: boolean;
  children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent
        ref={content}
        // Phone-width, a little taller than shadcn's 80vh. It takes focus on open
        // (onOpenAutoFocus), so no focus outline around the whole sheet.
        className="mx-auto max-w-xl outline-none data-[vaul-drawer-direction=bottom]:max-h-[85vh]"
        onOpenAutoFocus={(e) => {
          if (focusFirstField) return;
          e.preventDefault();
          content.current?.focus();
        }}
        // Radix warns about a dialog without a description unless told there is none.
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <DrawerHeader className="relative px-12 pb-3">
          <DrawerTitle className="text-lg font-bold">{title}</DrawerTitle>
          {description && <DrawerDescription>{description}</DrawerDescription>}
          <DrawerClose
            aria-label="Close"
            className="absolute top-2 right-2 rounded-full p-2 text-muted-foreground hover:bg-accent"
          >
            <X className="size-5" aria-hidden />
          </DrawerClose>
        </DrawerHeader>
        {/*
          The body scrolls (the drawer only drags when it's scrolled to the top). The bottom space
          lives here: it clears the home indicator plus a margin.
        */}
        <div className="overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1.5rem)]">
          {children}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
