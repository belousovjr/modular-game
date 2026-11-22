CREATE TABLE IF NOT EXISTS public.world_npc_checkpoints (
  room_id text NOT NULL,
  navigation text NOT NULL,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, navigation),
  CHECK (jsonb_typeof(state) = 'object')
);
