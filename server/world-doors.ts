import { Pool } from 'pg';
import { readDoorPoses, type DoorPose } from '../src/modules/building-interiors/headless.ts';

export function createDoorStore(connectionString: string, world: string) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, query_timeout: 5_000 });
  pool.on('error', () => console.error('World door storage connection failed'));
  return {
    async load() {
      const result = await pool.query<{ poses: unknown }>(
        'SELECT poses FROM public.world_door_checkpoints WHERE world_id = $1', [world],
      );
      const poses = readDoorPoses(result.rows[0]?.poses ?? []);
      if (!poses) throw new Error('Invalid door checkpoint');
      return poses;
    },
    async save(poses: readonly DoorPose[]) {
      await pool.query(
        `INSERT INTO public.world_door_checkpoints (world_id, poses) VALUES ($1, $2::jsonb)
         ON CONFLICT (world_id) DO UPDATE SET poses = EXCLUDED.poses, updated_at = now()`,
        [world, JSON.stringify(poses)],
      );
    },
    close: () => pool.end(),
  };
}
