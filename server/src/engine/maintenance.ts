import type {
  EngineId,
  EngineMaintenanceStatusDto,
} from '../contracts/index.js';

export interface EngineMaintenanceAdapter {
  readonly id: EngineId;
  getStatus(): Promise<EngineMaintenanceStatusDto>;
  checkLatest(): Promise<EngineMaintenanceStatusDto>;
}

export class EngineMaintenanceError extends Error {
  constructor(
    readonly code: 'ENGINE_MAINTENANCE_NOT_FOUND' | 'ENGINE_MAINTENANCE_DUPLICATE',
    message: string,
  ) {
    super(message);
    this.name = 'EngineMaintenanceError';
  }
}
