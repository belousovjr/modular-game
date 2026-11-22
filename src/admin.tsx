import { roomHttpUrl } from './room-endpoint.ts';
import { AlertDialog, Button, Callout, Card, DataList, Flex, Heading, Link, Text, Theme } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import { accessToken } from './auth.ts';
import type { RoomAdminStatus } from './room-admin-status.ts';

async function request<T>(path:string,method:'GET'|'POST',signal:AbortSignal) {
  const token=await accessToken();
  const start=performance.now();
  const response=await fetch(roomHttpUrl(path),{method,signal,headers:{Authorization:`Bearer ${token}`}});
  if(!response.ok){
    const data=await response.json().catch(()=>null);
    throw new Error(data?.error??'Комната недоступна.');
  }
  const data=await response.json();
  return {data:data as T,rtt:Math.round(performance.now()-start)};
}

export function Admin() {
  const [status,setStatus]=useState<RoomAdminStatus>();
  const [rtt,setRtt]=useState(0);
  const [error,setError]=useState('');
  const [resetError,setResetError]=useState('');
  const [busy,setBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    let timer:ReturnType<typeof setTimeout>|undefined;
    async function poll(){
      try {
        const sample=await request<RoomAdminStatus>('/admin/status','GET',AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));
        if(controller.signal.aborted)return;
        setStatus(sample.data);
        setRtt(sample.rtt);
        setError('');
      } catch(cause) {
        if(controller.signal.aborted)return;
        setError(cause instanceof Error?cause.message:'Комната недоступна.');
      }
      timer=setTimeout(poll,3000);
    }
    void poll();
    return ()=>{controller.abort();clearTimeout(timer);};
  },[refresh]);

  async function reset(){
    setBusy(true);
    setResetError('');
    try {
      await request<{ok:true}>('/admin/npcs/reset','POST',AbortSignal.timeout(25_000));
      setStatus(previous=>previous&&{...previous,population:0,resetInMs:60_000});
    } catch(cause) {
      setResetError(cause instanceof Error?cause.message:'Не удалось пересоздать NPC.');
    } finally {setBusy(false);setRefresh(value=>value+1);}
  }

  return <Theme appearance="dark"><main className="play-entry">
    <Card size="4" className="play-card"><Flex direction="column" gap="4">
      <Heading as="h1">Управление комнатой</Heading>
      <Link href="/play">К игре и входу</Link>
      {error && <Callout.Root role="alert" color="red"><Callout.Text>{error}</Callout.Text></Callout.Root>}
      {resetError && <Callout.Root role="alert" color="red"><Callout.Text>{resetError}</Callout.Text></Callout.Root>}
      {!status && !error && <Text role="status">Подключение к комнате…</Text>}
      {status && !error && <>
        <DataList.Root>
          <DataList.Item><DataList.Label>NPC в городе</DataList.Label><DataList.Value>{status.population?.toLocaleString('ru-RU')??'Отключены'}</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Игроки онлайн</DataList.Label><DataList.Value>{status.players}</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Отклик комнаты</DataList.Label><DataList.Value>{rtt} мс</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Время тика</DataList.Label><DataList.Value>{status.tickMs.toFixed(2)} мс в среднем, {status.maxTickMs.toFixed(2)} мс пик</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Пик очереди тиков</DataList.Label><DataList.Value>{status.maxPendingTicks}</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Загрузка цикла Node.js</DataList.Label><DataList.Value>{Math.round(status.eventLoopPercent)} %</DataList.Value></DataList.Item>
          <DataList.Item><DataList.Label>Память процесса</DataList.Label><DataList.Value>{Math.round(status.rssMiB)} МиБ</DataList.Value></DataList.Item>
        </DataList.Root>
        <AlertDialog.Root>
          <AlertDialog.Trigger>
            <Button color="red" variant="soft" disabled={busy||status.population===null||status.resetInMs>0}>
              {busy?'Сброс…':'Сбросить и пересоздать NPC'}
            </Button>
          </AlertDialog.Trigger>
          <AlertDialog.Content maxWidth="420px">
            <AlertDialog.Title>Пересоздать население?</AlertDialog.Title>
            <AlertDialog.Description>Текущие NPC исчезнут у всех игроков. Новые появятся постепенно.</AlertDialog.Description>
            <Flex gap="3" mt="4" justify="end">
              <AlertDialog.Cancel><Button variant="soft" color="gray">Отмена</Button></AlertDialog.Cancel>
              <AlertDialog.Action><Button color="red" onClick={()=>void reset()}>Пересоздать</Button></AlertDialog.Action>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
        {status.resetInMs>0 && <Text size="2" color="gray">Повторный сброс через {Math.ceil(status.resetInMs/1000)} с</Text>}
      </>}
    </Flex></Card>
  </main></Theme>;
}
