export type Provider = 'TalentNet' | 'Magnit' | 'KellyOCG' | 'Randstad' | 'LiveHire' | 'Raise' | 'Staffing Future' | 'Matador' | 'Insight Global';
export interface SourceConfig {
  id: string;
  company: string;
  provider: Provider;
  url: string;
  country: string;
  domain?: string;
  contractOnly: boolean;
}
const source = (id: string, company: string, provider: Provider, url: string, country = 'US', domain?: string, contractOnly = true): SourceConfig => ({ id, company, provider, url, country, domain, contractOnly });
export const SOURCES: SourceConfig[] = [
  source('meta','Meta','TalentNet','https://us.meta.talentnet.community/jobs/search'),
  source('microsoft','Microsoft','TalentNet','https://us.microsoft.talentnet.community/jobs/search'),
  source('airbnb','Airbnb','TalentNet','https://magnit-airbnb.talentnet.community/jobs/search'),
  source('boeing','Boeing','TalentNet','https://boeing.talentnet.community/jobs/search'),
  source('wellsfargo','Wells Fargo','TalentNet','https://wellsfargo.talentnet.community/jobs/search'),
  source('kpmg','KPMG','TalentNet','https://us.kpmg.talentnet.community/jobs/search'),
  ...[
    ['pinterest','Pinterest'],['coinbase','Coinbase'],['servicenow','ServiceNow'],
    ['thecignagroup','The Cigna Group'],['novartis','Novartis'],['diageo','Diageo'],
    ['universalmusicgroup','Universal Music Group'],['boehringer-ingelheim','Boehringer Ingelheim'],
    ['blackveatch','Black & Veatch'],['raymondjames','Raymond James'],['mufg','MUFG'],
    ['consumers-energy','Consumers Energy'],['cnb','City National Bank'],['connectiverx','ConnectiveRx'],
    ['guidewell','GuideWell'],['bpm','Blueprint Medicines'],['keysight','Keysight Technologies'],
    ['onebrooklynhealth','One Brooklyn Health'],
  ].map(([id, company]) => source(id,company,'Magnit',`https://directsource.magnitglobal.com/us/${id}/jobs`)),
  source('apple','Apple','Magnit','https://applecontingentworkforce.willhire.co/jobs'),
  ...[['comau','Comau'],['corning','Corning'],['toyota','Toyota']].map(([id, company]) => source(id,company,'Magnit',`https://${id}.willhire.co/jobs`)),
  source('vattenfall','Vattenfall','Magnit','https://vattenfall.eu.willhire.co/jobs','Europe'),
  source('jnj','Johnson & Johnson','KellyOCG','https://jnj.toptalents.com/','US','jnj'),
  source('astrazeneca','AstraZeneca','KellyOCG','https://astrazeneca.toptalents.com/','Global','astrazeneca'),
  source('farmers','Farmers Insurance','KellyOCG','https://farmers.toptalents.com/','US','farmers'),
  source('johndeere','John Deere','KellyOCG','https://johndeere.toptalents.com/','US','johndeere'),
  source('solidigm','Solidigm','KellyOCG','https://solidigm.toptalents.com/en','US','solidigm'),
  source('owenscorning','Owens Corning','KellyOCG','https://owenscorning.toptalents.com/','US','owenscorning'),
  source('avanos','Avanos','KellyOCG','https://avanos.toptalents.com/','US','avanos'),
  source('kellyocg','KellyOCG','KellyOCG','https://talentcontractcommunity.kellyservices.com/','Global'),
  source('enbridge','Enbridge','Raise','https://enbridge.raise.jobs/','North America'),
  source('epiq','Epiq','Raise','https://epiqcontingent.jobs/'),
  source('applied','Applied Materials','Raise','https://appliedcontract.jobs/'),
  source('inspyr','INSPYR Solutions','Staffing Future','https://www.inspyrsolutions.com/job-search/','US',undefined,false),
  source('insightglobal','Insight Global','Insight Global','https://insightglobal.com/jobs/search/all/all?sortBy=mostRecent&page=1','Global',undefined,false),
  source('tundra','Tundra Technical Solutions','Matador','https://community.tundratechnical.ca/jobs/','Global',undefined,false),
];

// Removed from collection because they never returned a usable public feed.
// The first four were blocked by LiveHire. The Randstad boards disallow
// automated collection in robots.txt, PNC and Workday never answered, and the
// rest had no public listing API. Their rows are pruned from the snapshot.
export const RETIRED_SOURCE_IDS = [
  'adm','abbott','halliburton','nikeinc',
  'pnc','workday',
  'barclays','tescobank','fidelityinternational','thales','booking','nestle','aviva','lonza',
  'applemarcom','iqvia','leonardo','tel','lyft',
];
