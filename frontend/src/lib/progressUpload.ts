export const MAX_PROGRESS_UPLOAD_FILES = 20;

export type ProgressCaptureSource = 'batch_camera' | 'device_camera' | 'library' | 'desktop' | 'unknown';

const GEOLOCATION_TIMEOUT_MS = 3500;

function getUploadPosition(): Promise<GeolocationPosition | null> {
  if (!navigator.geolocation) return Promise.resolve(null);

  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      position => resolve(position),
      () => resolve(null),
      {
        enableHighAccuracy: true,
        maximumAge: 60 * 1000,
        timeout: GEOLOCATION_TIMEOUT_MS,
      }
    );
  });
}

export async function appendProgressUploadAudit(
  formData: FormData,
  files: File[],
  sources: ProgressCaptureSource[] = []
) {
  const now = new Date();
  formData.append('taken_at_values', JSON.stringify(
    files.map(file => new Date(file.lastModified || now.getTime()).toISOString())
  ));
  formData.append('capture_recorded_at', now.toISOString());
  formData.append('capture_source_values', JSON.stringify(
    files.map((_, index) => sources[index] || 'unknown')
  ));
  formData.append('upload_session_id', `${now.getTime()}-${Math.random().toString(36).slice(2, 10)}`);

  const position = await getUploadPosition();
  if (!position) return;

  formData.append('capture_latitude', String(position.coords.latitude));
  formData.append('capture_longitude', String(position.coords.longitude));
  formData.append('capture_accuracy', String(position.coords.accuracy));
}
