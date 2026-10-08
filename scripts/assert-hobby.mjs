import { pathToFileURL } from 'node:url';

// Refuse publishing unless the authenticated deployment scope is explicitly Hobby.
export async function verifyHobbyScope(org,token,fetcher=fetch) {
  if(!token||!org)throw new Error('Configure VERCEL_TOKEN and VERCEL_ORG_ID as GitHub secrets.');
  if(!org.startsWith('team_'))throw new Error('Use a Hobby team scope so the free billing plan can be verified. Publishing stopped.');
  const path=`/v2/teams/${encodeURIComponent(org)}`;
  const response=await fetcher(new URL(path,'https://api.vercel.com'),{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Cannot verify the Vercel free plan (HTTP ${response.status}). Publishing stopped.`);
  const owner=await response.json();
  if(owner?.billing?.plan!=='hobby')throw new Error('The target is not a verified Hobby account. Publishing stopped; no paid deployment was requested.');
  if(owner.id!==org)throw new Error('Vercel account mismatch. Publishing stopped.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  await verifyHobbyScope(process.env.VERCEL_ORG_ID,process.env.VERCEL_TOKEN);
  console.log('Verified Vercel Hobby deployment scope.');
}
