// Standalone lighting preview. Loads the real classroom + all of its lights and
// lets you free-look around with the mouse — no match or server needed. Drops in
// plain capsule "students" so you can judge how the light falls on people.
// Open it at http://localhost:5173/preview.html
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { setupScene } from "./scene";
import { loadClassroom } from "./classroom";

async function main(): Promise<void> {
  const { scene, camera, renderer } = setupScene();
  const classroom = await loadClassroom(scene);
  classroom.root.visible = true; // the game hides the room until a match; show it here

  // Stand-in bodies (neutral capsules) at every seat + the speller spot, so the
  // lighting has subjects to fall on. Base sits on the floor (y = 0).
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x9aa0aa, roughness: 0.8, metalness: 0 });
  const addBody = (x: number, z: number, height: number) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, Math.max(0.2, height - 0.6), 6, 12), bodyMat);
    m.position.set(x, height / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    scene.add(m);
  };
  for (const seat of classroom.seats) addBody(seat.pos.x, seat.pos.z, 1.0); // seated
  addBody(classroom.spellerPos.x, classroom.spellerPos.z, 1.7); // standing speller

  // Start from the in-match camera POV, then hand control to the mouse.
  camera.position.copy(classroom.matchCam.pos);
  camera.quaternion.copy(classroom.matchCam.quat);
  camera.fov = classroom.matchCam.fov;
  camera.updateProjectionMatrix();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(classroom.spellerPos.x, 1.4, classroom.spellerPos.z);
  controls.update();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML(
    "beforeend",
    `<pre style="position:fixed;inset:0;margin:0;padding:24px;color:#fff;background:#111;` +
      `font:14px ui-monospace,monospace;white-space:pre-wrap">${(err as Error).message}\n\n${
        (err as Error).stack ?? ""
      }</pre>`
  );
});
