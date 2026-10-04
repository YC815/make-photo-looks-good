import { maskFromImageData, type Mask } from './mask';

/** A synthetic photo with a known subject, for trying the tool without a segmentation model. */
export function makeSample(): { image: HTMLCanvasElement; mask: Mask } {
  const w = 1400;
  const h = 1000;

  const subject = document.createElement('canvas');
  subject.width = w;
  subject.height = h;
  const s = subject.getContext('2d', { willReadFrequently: true })!;

  // A striped vase with a round bloom: lots of colour changes along its silhouette.
  s.save();
  s.beginPath();
  s.moveTo(560, 880);
  s.bezierCurveTo(470, 760, 460, 600, 560, 520);
  s.bezierCurveTo(610, 480, 610, 430, 590, 400);
  s.lineTo(710, 400);
  s.bezierCurveTo(690, 430, 690, 480, 740, 520);
  s.bezierCurveTo(840, 600, 830, 760, 740, 880);
  s.closePath();
  s.clip();
  const stripes = ['#1d3557', '#e63946', '#f1c453', '#2a9d8f', '#f4a261', '#7b2cbf', '#43aa8b', '#ff7aa2'];
  for (let y = 380, k = 0; y < 900; y += 34, k++) {
    s.fillStyle = stripes[k % stripes.length];
    s.fillRect(400, y, 500, 34);
  }
  const shade = s.createLinearGradient(460, 0, 840, 0);
  shade.addColorStop(0, 'rgba(0,0,0,0.35)');
  shade.addColorStop(0.45, 'rgba(255,255,255,0.15)');
  shade.addColorStop(1, 'rgba(0,0,0,0.4)');
  s.fillStyle = shade;
  s.fillRect(400, 380, 500, 520);
  s.restore();

  const petals = ['#ff006e', '#fb5607', '#ffbe0b', '#8338ec', '#3a86ff'];
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    s.beginPath();
    s.ellipse(650 + Math.cos(a) * 120, 250 + Math.sin(a) * 120, 95, 55, a, 0, Math.PI * 2);
    s.fillStyle = petals[i % petals.length];
    s.fill();
  }
  const core = s.createRadialGradient(640, 240, 10, 650, 250, 90);
  core.addColorStop(0, '#fff3b0');
  core.addColorStop(1, '#e09f3e');
  s.beginPath();
  s.arc(650, 250, 85, 0, Math.PI * 2);
  s.fillStyle = core;
  s.fill();
  s.fillStyle = '#2d6a4f';
  s.fillRect(640, 330, 20, 80);

  const mask = maskFromImageData(s.getImageData(0, 0, w, h));

  const image = document.createElement('canvas');
  image.width = w;
  image.height = h;
  const g = image.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#e9e4d8');
  sky.addColorStop(0.72, '#d8cfbd');
  sky.addColorStop(0.72, '#b9a88d');
  sky.addColorStop(1, '#a08f73');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.beginPath();
  g.ellipse(660, 885, 170, 22, 0, 0, Math.PI * 2);
  g.fill();
  g.drawImage(subject, 0, 0);
  return { image, mask };
}
