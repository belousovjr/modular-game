import {Flex,SegmentedControl,Text} from '@radix-ui/themes';
import {defineModule} from '../../core/context.ts';

const presets = [
  {value:'native',label:'Исходное',limit:null},
  {value:'1080p',label:'1080p',limit:[1920,1080]},
  {value:'720p',label:'720p',limit:[1280,720]},
  {value:'480p',label:'480p',limit:[854,480]},
  {value:'360p',label:'360p',limit:[640,360]},
] as const;

export const renderResolutionModule = defineModule({
  id: 'render-resolution', title: 'Разрешение рендера', category: 'Рендеринг', requires: {},
  setup({core,scope}) {
    const engine = core.scene.getEngine();
    const canvas = engine.getRenderingCanvas();
    if (!canvas) return {};

    const nativeScale = engine.getHardwareScalingLevel();
    let limit: (typeof presets)[number]['limit'] = null;
    const applyResolution = () => {
      const width = canvas.clientWidth, height = canvas.clientHeight;
      if (!width || !height) return;
      const scale = limit ? Math.max(nativeScale, width / limit[0], height / limit[1]) : nativeScale;
      if (engine.getHardwareScalingLevel() !== scale) engine.setHardwareScalingLevel(scale);
    };

    scope.onDispose(() => {
      if (engine.getHardwareScalingLevel() !== nativeScale) engine.setHardwareScalingLevel(nativeScale);
    });
    const observer = new ResizeObserver(applyResolution);
    scope.onDispose(() => observer.disconnect());
    observer.observe(canvas);

    scope.onDispose(core.panels.register('render-resolution','Разрешение рендера',
      <Flex direction="column" gap="2">
        <SegmentedControl.Root size="1" aria-label="Разрешение 3D-сцены" defaultValue="native" onValueChange={value => {
          limit = presets.find(preset => preset.value === value)?.limit ?? null;
          applyResolution();
        }}>
          {presets.map(({value,label}) => <SegmentedControl.Item key={value} value={value}>{label}</SegmentedControl.Item>)}
        </SegmentedControl.Root>
        <Text size="2">Ограничивает разрешение 3D-сцены. Интерфейс сохраняет чёткость.</Text>
      </Flex>,
    ));
    return {};
  },
});
