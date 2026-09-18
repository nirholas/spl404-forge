import * as THREE from 'three';

/**
 * A slow field of wireframe cells behind the page. It is decoration, so it never
 * blocks input, skips entirely under prefers-reduced-motion, and pauses whenever
 * the tab is hidden rather than burning a phone battery in the background.
 */
export function mountBackdrop(host) {
  if (!host || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
  } catch {
    return () => {};
  }

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(46, host.clientWidth / host.clientHeight || 1, 0.1, 120);
  camera.position.z = 9;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(host.clientWidth, host.clientHeight);
  host.append(renderer.domElement);

  const group = new THREE.Group();
  scene.add(group);
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const materials = [];
  for (let index = 0; index < 18; index += 1) {
    const accent = index % 5 === 0;
    const material = new THREE.MeshBasicMaterial({
      color: accent ? 0x9ff5c4 : 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: accent ? 0.16 : 0.06,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    const angle = index * 2.39996;
    const radius = 2.4 + (index % 6) * 0.78;
    mesh.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.52, ((index % 4) - 1.5) * 1.2);
    mesh.scale.setScalar(0.22 + (index % 5) * 0.12);
    group.add(mesh);
  }

  let pointerX = 0;
  let pointerY = 0;
  const onPointer = (event) => {
    pointerX = event.clientX / window.innerWidth - 0.5;
    pointerY = event.clientY / window.innerHeight - 0.5;
  };
  const onResize = () => {
    if (!host.clientWidth || !host.clientHeight) return;
    camera.aspect = host.clientWidth / host.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(host.clientWidth, host.clientHeight);
  };
  window.addEventListener('pointermove', onPointer, { passive: true });
  window.addEventListener('resize', onResize);

  let frame = 0;
  let running = true;
  const render = () => {
    frame = requestAnimationFrame(render);
    group.rotation.y += 0.0009;
    group.rotation.x += (pointerY * 0.07 - group.rotation.x) * 0.02;
    group.position.x += (pointerX * 0.8 - group.position.x) * 0.02;
    group.children.forEach((mesh, index) => { mesh.rotation.x += 0.0008 + index * 0.00006; });
    renderer.render(scene, camera);
  };
  render();

  const onVisibility = () => {
    if (document.hidden && running) {
      cancelAnimationFrame(frame);
      running = false;
    } else if (!document.hidden && !running) {
      running = true;
      render();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('pointermove', onPointer);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    geometry.dispose();
    materials.forEach((material) => material.dispose());
    renderer.dispose();
    renderer.domElement.remove();
  };
}
