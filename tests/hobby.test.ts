import { expect,it } from 'vitest';
// @ts-expect-error Small JavaScript CLI imported to verify the deployment guard.
import { verifyHobbyScope } from '../scripts/assert-hobby.mjs';

it('allows only the matching Hobby scope and fails closed for paid, unknown, or inaccessible accounts',async()=>{
  const response=(owner:unknown,status=200)=>async()=>Response.json(owner,{status});
  await expect(verifyHobbyScope('team_test','test-token',response({id:'team_test',billing:{plan:'hobby'}}))).resolves.toBeUndefined();
  for(const owner of [{id:'team_test',billing:{plan:'pro'}},{id:'team_test'},{id:'team_other',billing:{plan:'hobby'}}]) {
    await expect(verifyHobbyScope('team_test','test-token',response(owner))).rejects.toThrow('Publishing stopped');
  }
  await expect(verifyHobbyScope('team_test','test-token',response({},403))).rejects.toThrow('Publishing stopped');
  await expect(verifyHobbyScope('user_test','test-token',response({}))).rejects.toThrow('Publishing stopped');
});
