import {
  ForkKnife,
  Camera,
  Stethoscope,
  Toilet,
  Brain,
  Scroll,
  Sparkle,
  Plus,
  PencilSimple,
  Trash,
  NoteBlank,
  Warning,
  X,
  CaretLeft,
  CaretRight,
  GearSix,
  CreditCard,
  UploadSimple,
  DownloadSimple,
  FileText,
  SignOut,
  Sun,
  Moon,
  CircleHalf,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";

/**
 * Single source of truth for the app's icon set (Phosphor, solid/"fill").
 *
 * The rest of the app references these semantic names instead of importing
 * the icon library directly, so swapping libraries later means editing only
 * this file — same isolation philosophy as db.ts.
 *
 * Icons inherit color via `currentColor` and size with the `size` prop.
 */
export type IconProps = PhosphorIconProps;

// Solid weight throughout the interface.
const base: PhosphorIconProps = { weight: "fill" };

export const MealIcon = (p: IconProps) => <ForkKnife {...base} {...p} />;
export const CameraIcon = (p: IconProps) => <Camera {...base} {...p} />;
export const SymptomIcon = (p: IconProps) => <Stethoscope {...base} {...p} />;
export const BowelIcon = (p: IconProps) => <Toilet {...base} {...p} />;
export const CheckinIcon = (p: IconProps) => <Brain {...base} {...p} />;
export const LogsIcon = (p: IconProps) => <Scroll {...base} {...p} />;
export const InsightsIcon = (p: IconProps) => <Sparkle {...base} {...p} />;
export const AddIcon = (p: IconProps) => <Plus {...base} {...p} />;
export const EditIcon = (p: IconProps) => <PencilSimple {...base} {...p} />;
export const DeleteIcon = (p: IconProps) => <Trash {...base} {...p} />;
export const NoteIcon = (p: IconProps) => <NoteBlank {...base} {...p} />;
export const WarningIcon = (p: IconProps) => <Warning {...base} {...p} />;
export const CloseIcon = (p: IconProps) => <X {...base} {...p} />;
export const BackIcon = (p: IconProps) => <CaretLeft {...base} {...p} />;
export const ChevronIcon = (p: IconProps) => <CaretRight {...base} {...p} />;
export const SettingsIcon = (p: IconProps) => <GearSix {...base} {...p} />;
export const BillingIcon = (p: IconProps) => <CreditCard {...base} {...p} />;
export const BackupIcon = (p: IconProps) => <UploadSimple {...base} {...p} />;
export const RestoreIcon = (p: IconProps) => <DownloadSimple {...base} {...p} />;
export const CsvIcon = (p: IconProps) => <FileText {...base} {...p} />;
export const SignOutIcon = (p: IconProps) => <SignOut {...base} {...p} />;
export const LightIcon = (p: IconProps) => <Sun {...base} {...p} />;
export const DarkIcon = (p: IconProps) => <Moon {...base} {...p} />;
export const AutoThemeIcon = (p: IconProps) => <CircleHalf {...base} {...p} />;
