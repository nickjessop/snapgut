import {
  UtensilsCrossed,
  Camera,
  Stethoscope,
  Toilet,
  BrainCircuit,
  ScrollText,
  Sparkles,
  Plus,
  SquarePen,
  Trash2,
  StickyNote,
  TriangleAlert,
  X,
  ChevronLeft,
  ChevronRight,
  Settings,
  CreditCard,
  Upload,
  Download,
  FileText,
  LogOut,
  Sun,
  Moon,
  SunMoon,
  type LucideProps,
} from "lucide-react";

/**
 * Single source of truth for the app's icon set (Lucide).
 *
 * The rest of the app references these semantic names instead of importing
 * lucide directly, so swapping icon libraries later means editing only this
 * file — same isolation philosophy as db.ts.
 *
 * Icons inherit color via `currentColor` and default to a 1em square so they
 * size with the surrounding text unless a `size` is passed.
 */
export type IconProps = LucideProps;

const base: LucideProps = { strokeWidth: 2, absoluteStrokeWidth: false };

export const MealIcon = (p: IconProps) => <UtensilsCrossed {...base} {...p} />;
export const CameraIcon = (p: IconProps) => <Camera {...base} {...p} />;
export const SymptomIcon = (p: IconProps) => <Stethoscope {...base} {...p} />;
export const BowelIcon = (p: IconProps) => <Toilet {...base} {...p} />;
export const CheckinIcon = (p: IconProps) => <BrainCircuit {...base} {...p} />;
export const LogsIcon = (p: IconProps) => <ScrollText {...base} {...p} />;
export const InsightsIcon = (p: IconProps) => <Sparkles {...base} {...p} />;
export const AddIcon = (p: IconProps) => <Plus {...base} {...p} />;
export const EditIcon = (p: IconProps) => <SquarePen {...base} {...p} />;
export const DeleteIcon = (p: IconProps) => <Trash2 {...base} {...p} />;
export const NoteIcon = (p: IconProps) => <StickyNote {...base} {...p} />;
export const WarningIcon = (p: IconProps) => <TriangleAlert {...base} {...p} />;
export const CloseIcon = (p: IconProps) => <X {...base} {...p} />;
export const BackIcon = (p: IconProps) => <ChevronLeft {...base} {...p} />;
export const ChevronIcon = (p: IconProps) => <ChevronRight {...base} {...p} />;
export const SettingsIcon = (p: IconProps) => <Settings {...base} {...p} />;
export const BillingIcon = (p: IconProps) => <CreditCard {...base} {...p} />;
export const BackupIcon = (p: IconProps) => <Upload {...base} {...p} />;
export const RestoreIcon = (p: IconProps) => <Download {...base} {...p} />;
export const CsvIcon = (p: IconProps) => <FileText {...base} {...p} />;
export const SignOutIcon = (p: IconProps) => <LogOut {...base} {...p} />;
export const LightIcon = (p: IconProps) => <Sun {...base} {...p} />;
export const DarkIcon = (p: IconProps) => <Moon {...base} {...p} />;
export const AutoThemeIcon = (p: IconProps) => <SunMoon {...base} {...p} />;
