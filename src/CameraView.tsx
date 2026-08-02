import { useEffect, useRef, useState } from "react";
import { CameraIcon, LibraryIcon, NoPhotoIcon, CloseIcon } from "./icons";
import { acquireCamera, releaseCamera } from "./cameraStream";
import { dismissCameraHint, shouldOfferCameraHint } from "./cameraPermission";
import CameraPermissionSheet from "./CameraPermissionSheet";

interface Props {
  onCapture: (photo: Blob) => void;
  /** Log a meal with no photo at all — for something already eaten. */
  onSkipPhoto?: () => void;
}

export default function CameraView({ onCapture, onSkipPhoto }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * The library picker. Separate from `fileRef` because the two want opposite
   * hints: the fallback below asks for the camera (`capture="environment"`),
   * while this one must offer the existing photo library, and a single input
   * cannot mean both.
   */
  const libraryRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The permission tip. Read after the stream settles rather than at mount, because
   * this launch's own acquisition is part of the evidence for showing it.
   */
  const [permTip, setPermTip] = useState(false);
  const [permSheet, setPermSheet] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // Checked synchronously, before anything is awaited: where there is no camera
    // API at all — an insecure origin, an embedded view, a desktop without a
    // device — the fallback is the answer and there is nothing to wait for. Going
    // through the async path just to fail would render the live view for a frame
    // first and settle the fallback a tick later.
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("live");
      return;
    }

    async function start() {
      try {
        // Shared across mounts, so switching to Logs and back does not re-acquire
        // the device. See src/cameraStream.ts for what that does and does not fix.
        const stream = await acquireCamera();
        if (cancelled) {
          releaseCamera();
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        // Asked now, not at mount: `acquireCamera` has just filed this launch's timing,
        // so this is the first moment the answer includes it.
        setPermTip(shouldOfferCameraHint());
      } catch {
        // Fallback: no live camera access (e.g. permission denied, an insecure
        // origin, or no camera at all).
        //
        // Guarded on `cancelled` for the same reason the success path is: this
        // rejection can arrive after the view has gone, and updating state on an
        // unmounted component is both a warning and a real ordering hazard — the
        // update is left pending and lands during whatever renders next.
        if (!cancelled) setError("live");
      }
    }

    start();
    return () => {
      cancelled = true;
      // Detach from this element but do not stop the tracks — the stream outlives
      // this mount on purpose. `releaseCamera` stops it once nobody comes back.
      if (videoRef.current) videoRef.current.srcObject = null;
      streamRef.current = null;
      releaseCamera();
    };
  }, []);

  async function snap() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement("canvas");
    // Square crop, centered, capped at 1024px for cheap/fast inference.
    const size = Math.min(video.videoWidth, video.videoHeight);
    const target = Math.min(size, 1024);
    canvas.width = target;
    canvas.height = target;
    const ctx = canvas.getContext("2d")!;
    const sx = (video.videoWidth - size) / 2;
    const sy = (video.videoHeight - size) / 2;
    ctx.drawImage(video, sx, sy, size, size, 0, 0, target, target);
    canvas.toBlob(
      (blob) => blob && onCapture(blob),
      "image/jpeg",
      0.85
    );
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onCapture(file);
  }

  return (
    <div className="camera">
      {error === "live" ? (
        <div className="camera-fallback">
          <div className="cam-badge">
            <CameraIcon size={40} strokeWidth={1.75} />
          </div>
          <h2 className="cam-title">Snap your meal</h2>
          <p className="cam-sub">
            Take a photo and we'll pull out the ingredients automatically.
          </p>
          <button className="primary cam-cta" onClick={() => fileRef.current?.click()}>
            Take photo
          </button>
          {/* The same two alternatives as the live view. They matter more here,
              not less: this branch is reached when the camera is unavailable. */}
          <div className="cam-fallback-alts">
            <button className="link-btn" onClick={() => libraryRef.current?.click()}>
              Choose from library
            </button>
            <button className="link-btn" onClick={() => onSkipPhoto?.()}>
              Log without a photo
            </button>
          </div>
        </div>
      ) : (
        <>
          <video ref={videoRef} autoPlay playsInline muted />
          <div className="camera-scrim" />
          <div className="camera-hint">Point at your plate</div>

          {/* Offered only once iOS has plainly asked more than once — see
              cameraPermission.ts, which infers that from how long the grant took
              because the state itself cannot be read. */}
          {permTip && (
            <div className="camera-perm" role="status">
              <span>iOS asking for the camera every time?</span>
              <button className="camera-perm-fix" onClick={() => setPermSheet(true)}>
                Fix it
              </button>
              <button
                className="camera-perm-x"
                aria-label="Dismiss"
                onClick={() => {
                  dismissCameraHint();
                  setPermTip(false);
                }}
              >
                <CloseIcon size={15} />
              </button>
            </div>
          )}
          <div className="camera-controls">
            {/* Either side of the shutter: the two ways to log a meal you are not
                photographing right now. Both are secondary to the shutter, which
                keeps its size and position. */}
            <button
              className="cam-aux"
              aria-label="Choose a photo from your library"
              onClick={() => libraryRef.current?.click()}
            >
              <LibraryIcon size={22} />
            </button>
            <button className="shutter" aria-label="Take photo" onClick={snap} />
            <button
              className="cam-aux"
              aria-label="Log a meal without a photo"
              onClick={() => onSkipPhoto?.()}
            >
              <NoPhotoIcon size={22} />
            </button>
          </div>
        </>
      )}

      {/* The camera-first input, used by the no-live-camera fallback above. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />
      {/* No `capture` attribute, so this opens the photo library rather than the
          camera — the whole reason it is a second input. */}
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={onFilePicked}
      />

      {permSheet && (
        <CameraPermissionSheet
          onClose={() => {
            // Reading the steps is engaging with the tip, so it has served its purpose
            // either way and should not come back.
            dismissCameraHint();
            setPermSheet(false);
            setPermTip(false);
          }}
        />
      )}
    </div>
  );
}
