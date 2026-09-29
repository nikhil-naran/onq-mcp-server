/** A reservation bounds source downloads before allocating their buffers. */
export interface FileDeliveryReservation {
  publish(file: { data: Buffer; filename: string; mimeType: string }): {
    downloadUrl: string;
    expiresAt: string;
  };
  release(): void;
}

export interface FileDelivery {
  start(): Promise<void>;
  reserve(): FileDeliveryReservation;
  dispose(): Promise<void>;
}

export class FileDeliveryError extends Error {
  constructor(public readonly code: 'delivery_unavailable' | 'delivery_capacity_exceeded' | 'delivery_busy', message: string) {
    super(message);
    this.name = 'FileDeliveryError';
  }
}
