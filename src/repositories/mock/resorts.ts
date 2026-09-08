import type { ResortRepository } from '../types';
import type { ResortRecord } from '../domain';
import { mockResorts } from './fixtures';

export class MockResortRepository implements ResortRepository {
  async listResorts(): Promise<ResortRecord[]> {
    return [...mockResorts];
  }

  async getResortById(resortId: string): Promise<ResortRecord | null> {
    return mockResorts.find((r) => r.id === resortId) ?? null;
  }
}
