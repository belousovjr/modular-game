import { Badge, Box, Button, Callout, Card, Flex, Heading, Link, Popover, Text, TextField, Theme } from '@radix-ui/themes';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPanels, usePanels } from './core/panels.ts';
import { createViewport } from './core/scene.ts';
import { modules } from './registry.ts';
import { accessToken, auth } from './auth.ts';

const playModules = ['world', 'lighting', 'player-control', 'materials', 'shadows', 'minimap', 'atmosphere', 'night-lighting', 'render-resolution', 'vehicles', 'npcs'];
type Character = { id: string; name: string };
type User = { id: string; name: string };
function accountView(user: { id: string; email?: string; user_metadata: Record<string, unknown> }): User {
  const name = user.user_metadata.name;
  return { id: user.id, name: typeof name === 'string' ? name : user.email ?? '' };
}

async function characterRequest<T>(name?: string): Promise<T> {
  const response = await fetch('/api/characters', {
    method: name === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: name === undefined ? undefined : JSON.stringify({ name }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Сервис персонажей недоступен.');
  return data;
}

function Game({ character, leave }: { character: Character; leave(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fps, setFps] = useState(0);
  const [panels] = useState(createPanels);
  const entries = usePanels(panels);
  const minimap = entries.find(panel => panel.id === 'minimap');
  const vehicle = entries.find(panel => panel.id === 'vehicles');
  const [connection, setConnection] = useState({ message: 'Подключение…', inRoom: false });
  useEffect(() => {
    if (!canvas.current) return;
    let viewport: ReturnType<typeof createViewport> | undefined;
    try {
      viewport = createViewport(canvas.current, value => setFps(Math.round(value)), panels, () => {}, {
        characterId: character.id,
        accessToken,
        status: (message, inRoom) => setConnection({ message, inRoom }),
      });
      viewport.restart(modules, playModules);
    } catch (error) {
      viewport?.dispose();
      setConnection({ message: error instanceof Error ? error.message : 'Не удалось запустить игру.', inRoom: false });
      return;
    }
    return () => viewport.dispose();
  }, [character.id, panels]);
  return <main className="play-stage">
    <canvas ref={canvas} aria-label="Трёхмерная сцена" tabIndex={0} style={{ visibility: connection.inRoom ? 'visible' : 'hidden' }} />
    {connection.inRoom && minimap && <aside className="scene-overlay" aria-label={minimap.title}>{minimap.content}</aside>}
    {connection.inRoom && <Box className="fps"><Badge aria-label="Частота кадров">{fps || '—'} FPS</Badge></Box>}
    <Flex className="play-game-menu" gap="3" align="center" justify="end" wrap="wrap">
      <Badge role="status" color={connection.message === 'В сети' ? 'green' : 'amber'}>
        {connection.message}
      </Badge>
      {connection.inRoom && vehicle && <Popover.Root>
        <Popover.Trigger><Button color="gray" variant="soft">Автомобиль</Button></Popover.Trigger>
        <Popover.Content>{vehicle.content}</Popover.Content>
      </Popover.Root>}
      <Button color="gray" onClick={leave}>К персонажам</Button>
    </Flex>
  </main>;
}

export function Play() {
  const [user, setUser] = useState<User>();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [selected, setSelected] = useState<Character>();
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(!!auth);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function restore() {
      try {
        const session = await auth?.getSession();
        if (!active) return;
        if (session?.error) throw session.error;
        if (session?.data?.session?.user) {
          const account = accountView(session.data.session.user);
          setUser(account);
          const { characters } = await characterRequest<{ characters: Character[] }>();
          if (!active) return;
          setCharacters(characters);
          try {
            const id = sessionStorage.getItem('play/' + account.id);
            setSelected(characters.find(character => character.id === id));
          } catch { /* Play still works without session storage. */ }
        }
      } catch { if (active) setError('Не удалось восстановить сессию.'); }
      finally { if (active) setBusy(false); }
    }
    void restore();
    return () => { active = false; };
  }, []);

  async function submit(task: () => Promise<void>) {
    if (busy) return;
    setError('');
    setBusy(true);
    try { await task(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Запрос не выполнен.'); }
    finally { setBusy(false); }
  }
  function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const credentials = { email: String(data.get('email')).trim(), password: String(data.get('password')) };
    void submit(async () => {
      if (!auth) return;
      const result = registering
        ? await auth.signUp({ ...credentials, options: { data: { name: String(data.get('name')).trim() } } })
        : await auth.signInWithPassword(credentials);
      if (result.error) throw new Error(result.error.message ?? 'Не удалось войти.');
      const session = await auth.getSession();
      if (!session.data?.session?.user) {
        setRegistering(false);
        throw new Error('Аккаунт создан. Если пришло письмо Neon, подтвердите адрес, затем войдите.');
      }
      const { characters } = await characterRequest<{ characters: Character[] }>();
      setUser(accountView(session.data.session.user));
      setCharacters(characters);
    });
  }
  function choose(character?: Character) {
    if (!user) return;
    try {
      if (character) sessionStorage.setItem('play/' + user.id, character.id);
      else sessionStorage.removeItem('play/' + user.id);
    } catch { /* Optional reload recovery. */ }
    setSelected(character);
  }
  function createCharacter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('character')).trim();
    void submit(async () => {
      const { character } = await characterRequest<{ character: Character }>(name);
      setCharacters(list => [...list, character]);
      form.reset();
    });
  }
  if (selected) return <Theme appearance="dark"><Game character={selected} leave={() => choose()} /></Theme>;
  return <Theme appearance="dark"><main className="play-entry">
    <Card size="4" className="play-card"><Flex direction="column" gap="4">
      <Heading as="h1">{user ? 'Персонажи' : registering ? 'Регистрация' : 'Вход в игру'}</Heading>
      {!auth && <Callout.Root color="red"><Callout.Text>Не настроен адрес Neon Auth.</Callout.Text></Callout.Root>}
      {error && <Callout.Root color="red" role="alert"><Callout.Text>{error}</Callout.Text></Callout.Root>}
      {user ? <>
        <Text color="gray">{user.name}</Text>
        <Link href="/admin">Управление комнатой</Link>
        {characters.map(character => <Button key={character.id} disabled={busy} variant="soft" onClick={() => choose(character)}>{character.name}</Button>)}
        <form onSubmit={createCharacter}><Flex direction="column" gap="3">
          <Text as="label">Имя персонажа<TextField.Root name="character" required minLength={2} maxLength={32} /></Text>
          <Button disabled={busy}>Создать персонажа</Button>
        </Flex></form>
        <Button variant="ghost" disabled={busy} onClick={() => void submit(async () => {
          const result = await auth?.signOut();
          if (result?.error) throw new Error(result.error.message ?? 'Не удалось выйти.');
          choose();
          setUser(undefined);
          setCharacters([]);
        })}>Выйти из аккаунта</Button>
      </> : <>
        <form onSubmit={authenticate}><Flex direction="column" gap="3">
          {registering && <Text as="label">Имя аккаунта<TextField.Root name="name" autoComplete="name" required maxLength={64} /></Text>}
          <Text as="label">Почта<TextField.Root name="email" type="email" autoComplete="email" required /></Text>
          <Text as="label">Пароль<TextField.Root name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : undefined} /></Text>
          <Button disabled={busy || !auth}>{registering ? 'Зарегистрироваться' : 'Войти'}</Button>
        </Flex></form>
        <Button variant="ghost" disabled={busy || !auth} onClick={() => { setRegistering(!registering); setError(''); }}>
          {registering ? 'У меня есть аккаунт' : 'Создать аккаунт'}
        </Button>
      </>}
    </Flex></Card>
  </main></Theme>;
}
