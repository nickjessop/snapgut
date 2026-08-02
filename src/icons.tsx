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
  Flame,
  Info,
  Question,
  Images,
  ArrowClockwise,
  Check,
  ForkKnife as ForkKnifeOutline,
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
// A clean straight "+" (not the blocky fill glyph) for the center FAB.
export const AddIcon = (p: IconProps) => <Plus weight="bold" {...p} />;
export const EditIcon = (p: IconProps) => <PencilSimple {...base} {...p} />;
export const DeleteIcon = (p: IconProps) => <Trash {...base} {...p} />;
export const NoteIcon = (p: IconProps) => <NoteBlank {...base} {...p} />;
export const WarningIcon = (p: IconProps) => <Warning {...base} {...p} />;
export const CloseIcon = (p: IconProps) => <X {...base} {...p} />;
/**
 * Back, as a caret stroke rather than a solid wedge.
 *
 * The glyph was already `CaretLeft`, but it inherited `weight: "fill"` from `base`
 * with everything else, which renders it as a filled triangle — heavier than a back
 * control should be, and not what a caret looks like. `bold` keeps it legible at
 * small sizes without becoming a shape.
 */
export const BackIcon = (p: IconProps) => <CaretLeft weight="bold" {...p} />;
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
export const StreakIcon = (p: IconProps) => <Flame {...base} {...p} />;
export const InfoIcon = (p: IconProps) => <Info {...base} {...p} />;
export const HelpIcon = (p: IconProps) => <Question {...base} {...p} />;

/** Regenerate the current AI insight. */
export const RefreshIcon = (p: IconProps) => <ArrowClockwise weight="bold" {...p} />;

/** Acknowledge and dismiss — the "Got it" that closes an explainer tray. */
export const CheckIcon = (p: IconProps) => <Check weight="bold" {...p} />;

// The two camera-screen alternatives to taking a photo right now.
export const LibraryIcon = (p: IconProps) => <Images {...base} {...p} />;
/** "Log a meal, no photo" — the meal mark in outline, so it reads as the
 *  photo-less sibling of the shutter rather than as a second capture button. */
export const NoPhotoIcon = (p: IconProps) => (
  <ForkKnifeOutline weight="regular" {...p} />
);
