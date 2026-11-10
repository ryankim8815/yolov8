const assert=require('node:assert/strict'),test=require('node:test');
const mod=import('../app/static/robot-arm.js');
const make=steps=>({generic:true,simulation_only:true,errors:[],idle_opening_mm:80,width_mm:40,config:{standby_joints:[-80,0,90,0,90,0]},steps:steps.map((s,i)=>({number:i+1,title:'자유 단계 '+(i+1),speed:{speed:10,acceleration:5},...s}))});
const options={yieldFrame:()=>Promise.resolve()};

test('a free preset beginning with a line or arc uses its saved goal rather than legacy standby',async()=>{
 const m=await mod,start=[...m.defaultArmJoints],goal=[10,0,90,0,90,0],tool=m.poseFrame(m.simulationToolPose);
 const via=m.framePose(m.multiply(m.armFrames([5,0,90,0,90,0])[6],tool));
 for(const motion of ['movel','movec']){
  const recipe=make([{kind:motion==='movel'?'line':'circle',motion,space:'joint',target:goal,via_pose:via}]);
  const plan=await m.planScenarioSimulation(start,recipe,options);
  for(let j=0;j<6;j++)assert.ok(Math.abs(plan.samples.at(-1).angles[j]-goal[j])<.5);
  assert.equal(plan.route.length,1);assert.deepEqual(plan.gates,[]);
 }
});

test('free gripper, wait and arm operations keep their order and complete without legacy confirmation gates',async()=>{
 const m=await mod,goal=[15,0,90,0,90,0];
 const recipe=make([{kind:'gripper',opening_mm:50},{kind:'gripper',contact:true},{kind:'wait',seconds:.7},{kind:'joint',motion:'movej',space:'joint',target:goal},{kind:'gripper',opening_mm:65}]);
 const plan=await m.planScenarioSimulation(m.defaultArmJoints,recipe,options);
 assert.equal(plan.route.length,5);assert.deepEqual(plan.gates,[]);
 assert.equal(plan.samples.findLast(s=>s.segment===0).opening_mm,50);
 assert.equal(plan.samples.findLast(s=>s.segment===1).holding,true);
 assert.equal(plan.samples.findLast(s=>s.segment===2).holding,true);
 assert.deepEqual(plan.samples.at(-1).angles,goal);
 const frame=m.sampleArmSimulation(plan,plan.duration);
 assert.equal(frame.complete,true);assert.equal(frame.opening_mm,65);assert.equal(frame.holding,false);
});

test('empty free paths are rejected and 100 wait stages have finite progress',async()=>{
 const m=await mod;
 await assert.rejects(m.planScenarioSimulation(m.defaultArmJoints,make([]),options),/한 개 이상/);
 const plan=await m.planScenarioSimulation(m.defaultArmJoints,make(Array.from({length:100},()=>({kind:'wait',seconds:.1}))),options);
 assert.equal(plan.route.length,100);assert.ok(Number.isFinite(plan.duration));
 assert.equal(m.sampleArmSimulation(plan,plan.duration).complete,true);
});
