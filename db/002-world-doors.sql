CREATE TABLE IF NOT EXISTS public.world_door_checkpoints (
  world_id text PRIMARY KEY,
  poses jsonb NOT NULL CHECK (jsonb_typeof(poses) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
