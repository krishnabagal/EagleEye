const express = require('express');
const path    = require('path');

const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
const { EC2Client, DescribeInstancesCommand, DescribeAddressesCommand, DescribeVolumesCommand,
        DescribeVpcsCommand, DescribeSubnetsCommand, DescribeNatGatewaysCommand,
        DescribeInternetGatewaysCommand, DescribeSecurityGroupsCommand, DescribeKeyPairsCommand } = require('@aws-sdk/client-ec2');
const { S3Client, ListBucketsCommand }                               = require('@aws-sdk/client-s3');
const { STSClient, GetCallerIdentityCommand }                        = require('@aws-sdk/client-sts');
const { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand } = require('@aws-sdk/client-elastic-load-balancing-v2');
const { RDSClient, DescribeDBInstancesCommand }                      = require('@aws-sdk/client-rds');

const app  = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── CLIENT CACHE (per region) ──
const clientCache = {};
function getClients(region) {
  if (clientCache[region]) return clientCache[region];
  const cfg = { region };
  clientCache[region] = {
    ce:  new CostExplorerClient({ region: 'us-east-1' }),
    ec2: new EC2Client(cfg),
    s3:  new S3Client(cfg),
    sts: new STSClient(cfg),
    elb: new ElasticLoadBalancingV2Client(cfg),
    rds: new RDSClient(cfg),
  };
  return clientCache[region];
}

// ── DATE HELPERS ──
const fmtDate = d => d.toISOString().split('T')[0];

// Range for a specific year+month (0-based month index)
// Uses string arithmetic to avoid UTC timezone drift
function monthRange(year, month) {
  const now = new Date();
  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth();
  const pad = n => String(n).padStart(2,'0');

  // CE start: always 1st of the month
  const startStr = `${year}-${pad(month+1)}-01`;

  // CE end is EXCLUSIVE (next day / next month first)
  let ceEndStr;
  if (isCurrentMonth) {
    // end = tomorrow (today+1) so CE includes today
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1);
    ceEndStr = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth()+1)}-${pad(tomorrow.getDate())}`;
  } else {
    // end = first day of NEXT month
    const nm = month + 2; // month is 0-based, +1 for 1-based, +1 for next month
    ceEndStr = nm > 12
      ? `${year+1}-01-01`
      : `${year}-${pad(nm)}-01`;
  }

  // Display dates (human-readable, no CE exclusion trick)
  const displayStart = startStr; // always 1st
  const lastDay = new Date(year, month+1, 0).getDate();
  const displayEnd = isCurrentMonth
    ? `${year}-${pad(month+1)}-${pad(now.getDate())}`
    : `${year}-${pad(month+1)}-${pad(lastDay)}`;

  return { start: startStr, end: ceEndStr, displayStart, displayEnd, isCurrentMonth };
}

function yearRange(year) {
  const now = new Date();
  const y   = year || now.getFullYear();
  const end = y === now.getFullYear()
    ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
    : new Date(y + 1, 0, 1);
  return { start: `${y}-01-01`, end: fmtDate(end) };
}

// ── COST EXPLORER ──
async function ceCostByService(ce, start, end) {
  try {
    const res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    }));
    return (res.ResultsByTime || []).flatMap(r => r.Groups || []).reduce((acc, g) => {
      const cost = parseFloat(g.Metrics.UnblendedCost.Amount);
      if (cost > 0.005) acc[g.Keys[0]] = (acc[g.Keys[0]] || 0) + cost;
      return acc;
    }, {});
  } catch (e) { console.warn('CE services:', e.message); return {}; }
}

async function ceMonthlyTotals(ce, year) {
  const { start, end } = yearRange(year);
  try {
    const res = await ce.send(new GetCostAndUsageCommand({
      TimePeriod: { Start: start, End: end },
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
    }));
    const L = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return (res.ResultsByTime || []).map(r => ({
      month:  L[new Date(r.TimePeriod.Start).getMonth()],
      amount: parseFloat(parseFloat(r.Total.UnblendedCost.Amount).toFixed(2))
    }));
  } catch (e) { console.warn('CE monthly:', e.message); return []; }
}

const toList = map => Object.entries(map)
  .map(([name, cost]) => ({ name, cost: parseFloat(cost.toFixed(2)) }))
  .sort((a, b) => b.cost - a.cost);

// ── INFRA FETCHERS ──
async function fetchEC2Stats(ec2) {
  try {
    let instances = [], token;
    do {
      const r = await ec2.send(new DescribeInstancesCommand({ MaxResults: 1000, NextToken: token }));
      instances.push(...(r.Reservations?.flatMap(x => x.Instances) || []));
      token = r.NextToken;
    } while (token);
    return {
      total:   instances.length,
      running: instances.filter(i => i.State?.Name === 'running').length,
      stopped: instances.filter(i => ['stopped','stopping'].includes(i.State?.Name)).length,
      types:   [...new Set(instances.map(i => i.InstanceType))].slice(0, 5),
    };
  } catch (e) { console.warn('EC2:', e.message); return { total:0, running:0, stopped:0, types:[] }; }
}

async function fetchElasticIPs(ec2) {
  try {
    const r = await ec2.send(new DescribeAddressesCommand({}));
    const all = r.Addresses || [];
    return { total: all.length, unused: all.filter(a => !a.AssociationId).length };
  } catch (e) { console.warn('EIPs:', e.message); return { total:0, unused:0 }; }
}

async function fetchVolumes(ec2) {
  try {
    let vols = [], token;
    do {
      const r = await ec2.send(new DescribeVolumesCommand({ MaxResults: 500, NextToken: token }));
      vols.push(...(r.Volumes || []));
      token = r.NextToken;
    } while (token);
    return {
      total:  vols.length,
      gp2:    vols.filter(v => v.VolumeType === 'gp2').length,
      gp3:    vols.filter(v => v.VolumeType === 'gp3').length,
      unused: vols.filter(v => v.State === 'available').length,
      gp2Gb:  vols.filter(v => v.VolumeType === 'gp2').reduce((s,v) => s + v.Size, 0),
    };
  } catch (e) { console.warn('Volumes:', e.message); return { total:0, gp2:0, gp3:0, unused:0, gp2Gb:0 }; }
}

async function fetchVPCStats(ec2) {
  try {
    const [vpcs, subnets, nats, igws, sgs, kps] = await Promise.all([
      ec2.send(new DescribeVpcsCommand({})),
      ec2.send(new DescribeSubnetsCommand({})),
      ec2.send(new DescribeNatGatewaysCommand({ Filter:[{Name:'state',Values:['available']}] })),
      ec2.send(new DescribeInternetGatewaysCommand({})),
      ec2.send(new DescribeSecurityGroupsCommand({})),
      ec2.send(new DescribeKeyPairsCommand({})),
    ]);
    const allSubs = subnets.Subnets || [];
    const pub = allSubs.filter(s => s.MapPublicIpOnLaunch).length;
    return {
      vpcs:             (vpcs.Vpcs || []).length,
      subnets:          { total: allSubs.length, public: pub, private: allSubs.length - pub },
      natGateways:      (nats.NatGateways || []).length,
      internetGateways: (igws.InternetGateways || []).length,
      securityGroups:   (sgs.SecurityGroups || []).length,
      keyPairs:         (kps.KeyPairs || []).length,
    };
  } catch (e) { console.warn('VPC:', e.message); return { vpcs:0, subnets:{total:0,public:0,private:0}, natGateways:0, internetGateways:0, securityGroups:0, keyPairs:0 }; }
}

async function fetchALBStats(elb) {
  try {
    let lbs = [], token;
    do {
      const r = await elb.send(new DescribeLoadBalancersCommand({ Marker: token }));
      lbs.push(...(r.LoadBalancers || []));
      token = r.NextMarker;
    } while (token);
    const albs = lbs.filter(lb => lb.Type === 'application');
    return {
      total:   albs.length,
      public:  albs.filter(lb => lb.Scheme === 'internet-facing').length,
      private: albs.filter(lb => lb.Scheme === 'internal').length,
    };
  } catch (e) { console.warn('ALB:', e.message); return { total:0, public:0, private:0 }; }
}

async function fetchS3Count(s3) {
  try {
    const r = await s3.send(new ListBucketsCommand({}));
    return (r.Buckets || []).length;
  } catch (e) { console.warn('S3:', e.message); return 0; }
}

async function fetchRDSStats(rds) {
  try {
    let instances = [], marker;
    do {
      const r = await rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }));
      instances.push(...(r.DBInstances || []));
      marker = r.Marker;
    } while (marker);

    const available = instances.filter(i => i.DBInstanceStatus === 'available').length;
    const stopped   = instances.filter(i => i.DBInstanceStatus === 'stopped').length;

    // Count by engine
    const engines = {};
    for (const i of instances) {
      const eng = i.Engine || 'unknown';
      engines[eng] = (engines[eng] || 0) + 1;
    }

    // Identify optimization targets
    const multiAZ      = instances.filter(i => i.MultiAZ).length;
    const nonMultiAZ   = instances.length - multiAZ;
    const gp2RDS       = instances.filter(i => i.StorageType === 'gp2').length;
    const smallStopped = instances.filter(i => i.DBInstanceStatus === 'stopped').map(i => i.DBInstanceIdentifier);

    return { total: instances.length, available, stopped, engines, multiAZ, nonMultiAZ, gp2Storage: gp2RDS, stoppedIds: smallStopped };
  } catch (e) { console.warn('RDS:', e.message); return { total:0, available:0, stopped:0, engines:{}, multiAZ:0, nonMultiAZ:0, gp2Storage:0, stoppedIds:[] }; }
}

// ── COST SAVING RECOMMENDATIONS ──
function buildRecommendations(data) {
  const { services, infraStats, currentMonthTotal } = data;
  const recs = [];
  const svc  = name => services.find(s => s.name.toLowerCase().includes(name.toLowerCase()));

  // ── 1. Unused Elastic IPs ──
  if (infraStats.elasticIPs.unused > 0) {
    recs.push({
      category:'Networking', priority:'HIGH', icon:'🌐',
      title:`Release ${infraStats.elasticIPs.unused} Unused Elastic IP${infraStats.elasticIPs.unused>1?'s':''}`,
      description:`Elastic IPs not attached to a running instance are charged at $3.60/month each. Releasing unused ones is instant and free.`,
      monthlySaving: infraStats.elasticIPs.unused * 3.6,
      action:'EC2 → Elastic IPs → select unassociated IPs → Actions → Release',
    });
  }

  // ── 2. Unused EBS Volumes ──
  if (infraStats.volumes.unused > 0) {
    recs.push({
      category:'Storage', priority:'HIGH', icon:'💾',
      title:`Delete ${infraStats.volumes.unused} Unattached EBS Volume${infraStats.volumes.unused>1?'s':''}`,
      description:`Volumes in "available" state are detached but still billed (~$0.08–$0.10/GB/month). Snapshot them first if data is needed, then delete.`,
      monthlySaving: infraStats.volumes.unused * 8,
      action:'EC2 → Volumes → Filter "State = available" → create snapshot if needed → Delete',
    });
  }

  // ── 3. GP2 → GP3 Migration ──
  if (infraStats.volumes.gp2 > 0) {
    const saving = Math.max(infraStats.volumes.gp2Gb * 0.02, infraStats.volumes.gp2 * 2);
    recs.push({
      category:'Storage', priority:'MEDIUM', icon:'📀',
      title:`Migrate ${infraStats.volumes.gp2} GP2 Volumes to GP3`,
      description:`GP3 is 20% cheaper than GP2 ($0.08/GB vs $0.10/GB) and delivers 3,000 IOPS & 125 MB/s baseline for free. Zero downtime — modify in-place.`,
      monthlySaving: saving,
      action:'EC2 → Volumes → select gp2 volume → Modify Volume → type: gp3 → Modify',
    });
  }

  // ── 4. Stopped EC2 Instances ──
  if (infraStats.ec2.stopped > 0) {
    recs.push({
      category:'Compute', priority:'MEDIUM', icon:'🖥️',
      title:`Review ${infraStats.ec2.stopped} Stopped EC2 Instance${infraStats.ec2.stopped>1?'s':''}`,
      description:`Stopped instances still incur EBS storage costs and may hold allocated Elastic IPs. Create an AMI snapshot for recovery, then terminate if truly unused.`,
      monthlySaving: infraStats.ec2.stopped * 5,
      action:'EC2 → Instances → filter "stopped" → create AMI if needed → Terminate Instance',
    });
  }

  // ── 5. EC2 CPU/Memory Right-Sizing ──
  const ec2Svc = svc('Elastic Compute Cloud') || svc('EC2');
  if (ec2Svc && ec2Svc.cost > 100) {
    recs.push({
      category:'Compute', priority:'HIGH', icon:'📉',
      title:'Right-size Underutilized EC2 Instances (CPU / Memory / Network)',
      description:`Analyze CloudWatch metrics over 14+ days. Instances with avg CPU < 20%, memory < 40%, or network < 5% are strong right-sizing candidates. Moving from m5.xlarge → m5.large alone saves ~50%. AWS Compute Optimizer identifies these automatically and recommends smaller instance types with no guesswork.`,
      monthlySaving: ec2Svc.cost * 0.20,
      action:'Enable AWS Compute Optimizer → EC2 dashboard → apply instance type recommendations → test in staging first',
    });
  }

  // ── 6. Spot Instances for Non-Critical Workloads ──
  if (ec2Svc && ec2Svc.cost > 150) {
    recs.push({
      category:'Compute', priority:'HIGH', icon:'⚡',
      title:'Use Spot Instances for Fault-Tolerant & Batch Workloads',
      description:`Spot Instances cost up to 90% less than On-Demand. Ideal for CI/CD runners, data processing, dev/test environments, and stateless services behind an ALB. Use Spot with Auto Scaling Groups and mixed instance policies to maintain availability automatically.`,
      monthlySaving: ec2Svc.cost * 0.35,
      action:'EC2 → Auto Scaling Groups → edit → Mixed Instances Policy → add Spot capacity with On-Demand base',
    });
  }

  // ── 7. Savings Plans & Reserved Instances ──
  if (currentMonthTotal > 300) {
    recs.push({
      category:'Pricing', priority:'HIGH', icon:'💰',
      title:'Commit to Savings Plans or Reserved Instances for Steady Workloads',
      description:`Compute Savings Plans save 66% vs On-Demand for steady EC2/Lambda/Fargate. EC2 Instance Savings Plans save up to 72%. 1-year no-upfront saves ~30%; 3-year all-upfront saves up to 60%. Use Cost Explorer's purchase recommendations to find the optimal commitment level based on your actual usage patterns.`,
      monthlySaving: currentMonthTotal * 0.30,
      action:'Cost Explorer → Savings Plans → Purchase Recommendations → buy via AWS Console or CLI',
    });
  }

  // ── 8. NAT Gateway Consolidation ──
  if (infraStats.natGateways > 1) {
    recs.push({
      category:'Networking', priority:'MEDIUM', icon:'🔀',
      title:`Audit ${infraStats.natGateways} NAT Gateways — Consolidate Low-Traffic Ones`,
      description:`Each NAT Gateway costs $32/month + $0.045/GB processed. If subnets in the same AZ share workloads, a single NAT per AZ is sufficient. Enable VPC Flow Logs first to measure actual usage before consolidating.`,
      monthlySaving: (infraStats.natGateways - 1) * 32 * 0.35,
      action:'Enable VPC Flow Logs → identify low-traffic NATs → update route tables → delete redundant NATs',
    });
  }

  // ── 9. S3 Intelligent Tiering & Lifecycle Policies ──
  const s3Svc = svc('S3') || svc('Simple Storage');
  if (s3Svc && s3Svc.cost > 10) {
    recs.push({
      category:'S3 Storage', priority:'HIGH', icon:'🪣',
      title:'Enable S3 Intelligent-Tiering & Lifecycle Policies Across All Buckets',
      description:`S3 Standard ($0.023/GB) is expensive for infrequently accessed data. Enable Intelligent-Tiering on buckets with unpredictable access — it auto-moves objects between tiers with no retrieval fees. Add lifecycle rules: transition objects >30 days to Standard-IA ($0.0125/GB), >90 days to Glacier Instant Retrieval ($0.004/GB), and expire stale multipart uploads automatically.`,
      monthlySaving: s3Svc.cost * 0.40,
      action:'S3 → each bucket → Management → Lifecycle rules → add transition & expiration rules; also enable Intelligent-Tiering storage class',
    });
  }

  // ── 10. S3 Bucket Versioning & Replication Audit ──
  if (infraStats.s3Buckets > 5) {
    recs.push({
      category:'S3 Storage', priority:'MEDIUM', icon:'🗂️',
      title:`Audit S3 Versioning & Replication Costs Across ${infraStats.s3Buckets} Buckets`,
      description:`Versioning stores every object version indefinitely — old versions accumulate silently and can multiply storage costs 3–10x. Add lifecycle rules to expire non-current versions after 30–90 days. Review cross-region replication rules; replicated data is double-billed for storage and replication transfer.`,
      monthlySaving: infraStats.s3Buckets * 3,
      action:'S3 → bucket → Management → Lifecycle → add "expire non-current versions" rule (e.g. after 30 days)',
    });
  }

  // ── 11. S3 Access Patterns & Glacier Deep Archive ──
  if (s3Svc && s3Svc.cost > 30) {
    recs.push({
      category:'S3 Storage', priority:'MEDIUM', icon:'📦',
      title:'Analyze S3 Access Patterns with Storage Lens & Move Cold Data to Glacier',
      description:`Use S3 Storage Lens to identify buckets with zero GET requests in 30+ days — these are ideal for Glacier Deep Archive ($0.00099/GB, 83% cheaper than Standard). Also enable S3 request metrics to catch buckets paying for storage but never being accessed.`,
      monthlySaving: s3Svc.cost * 0.25,
      action:'S3 → Storage Lens → enable dashboard → filter by last-access date → move cold buckets to Glacier Deep Archive',
    });
  }

  // ── 12. S3 Multipart Upload Cleanup ──
  if (s3Svc) {
    recs.push({
      category:'S3 Storage', priority:'LOW', icon:'🧹',
      title:'Clean Up Incomplete Multipart Uploads & Expired Delete Markers',
      description:`Incomplete multipart uploads and expired object delete markers silently accumulate storage costs. A single lifecycle rule can auto-abort incomplete uploads after 7 days and remove expired delete markers, saving storage you didn't know you were paying for.`,
      monthlySaving: Math.max(infraStats.s3Buckets * 1.5, 10),
      action:'S3 → bucket → Management → Lifecycle → Add rule: "Delete expired object delete markers" + "Abort incomplete multipart uploads after 7 days"',
    });
  }

  // ── 13. S3 Request Cost Optimization ──
  if (s3Svc && s3Svc.cost > 20) {
    recs.push({
      category:'S3 Storage', priority:'LOW', icon:'📡',
      title:'Reduce S3 Request Costs with Transfer Acceleration & Batch Operations',
      description:`S3 LIST/PUT/GET requests add up at high volume. Use S3 Batch Operations for bulk actions instead of looping API calls. For cross-region uploads, Transfer Acceleration uses CloudFront edge locations which can be cheaper than repeated retry costs from slow connections. Also consolidate small objects into archives to reduce per-request charges.`,
      monthlySaving: s3Svc.cost * 0.10,
      action:'Review S3 request metrics per bucket → enable S3 Batch Operations for bulk tasks → consolidate small-object workloads',
    });
  }

  // ── 14. RDS Optimization ──
  const rdsSvc = svc('Relational Database') || svc('RDS');
  if (rdsSvc && rdsSvc.cost > 80) {
    recs.push({
      category:'Database', priority:'MEDIUM', icon:'🗄️',
      title:'Optimize RDS — Reserved Instances, Aurora Serverless & Right-sizing',
      description:`RDS spend is $${rdsSvc.cost.toFixed(0)}/month. 1-year Reserved Instances save ~35%. For dev/test multi-AZ databases, disable Multi-AZ outside business hours. For variable workloads, Aurora Serverless v2 auto-scales and pauses, cutting idle costs by up to 60%.`,
      monthlySaving: rdsSvc.cost * 0.28,
      action:'RDS → Recommendations → purchase Reserved Instances; or migrate variable workloads to Aurora Serverless v2',
    });
  }

  // ── 13. Lambda Optimization ──
  const lambdaSvc = svc('Lambda');
  if (lambdaSvc && lambdaSvc.cost > 20) {
    recs.push({
      category:'Compute', priority:'LOW', icon:'λ',
      title:'Optimize Lambda — Memory Tuning, arm64 Graviton & Tiered Pricing',
      description:`Lambda is billed per GB-second. Use the AWS Lambda Power Tuning tool to find the optimal memory setting (often lower memory = same speed at lower cost). Switch to arm64 (Graviton2) for up to 20% cost reduction with no code changes for most runtimes.`,
      monthlySaving: lambdaSvc.cost * 0.18,
      action:'Deploy Lambda Power Tuning Step Function → run on key functions → switch to arm64 architecture in function config',
    });
  }

  // ── 14. Data Transfer → CloudFront + VPC Endpoints ──
  const dtSvc = svc('Data Transfer');
  if (dtSvc && dtSvc.cost > 30) {
    recs.push({
      category:'Networking', priority:'MEDIUM', icon:'📡',
      title:'Cut Data Transfer Costs — CloudFront CDN & VPC Gateway Endpoints',
      description:`Data transfer out of AWS costs $0.09/GB. CloudFront serves cached content at $0.0085/GB after 10TB (90% cheaper). Add free S3 and DynamoDB VPC Gateway Endpoints to eliminate NAT Gateway data processing charges for traffic to these services.`,
      monthlySaving: dtSvc.cost * 0.45,
      action:'Create CloudFront distribution for S3/ALB origins; add VPC → Endpoints → S3 and DynamoDB Gateway Endpoints',
    });
  }

  // ── 15. CloudWatch Log Retention ──
  recs.push({
    category:'Monitoring', priority:'LOW', icon:'📊',
    title:'Set CloudWatch Log Group Retention to Avoid Indefinite Storage',
    description:`By default, CloudWatch Log Groups retain logs forever at $0.03/GB/month. Applications generating 100GB/month of logs that never expire cost $36/month for storage alone. Set 30-day retention for app logs, 7-day for debug logs, 90-day for audit logs.`,
    monthlySaving: 20,
    action:'CloudWatch → Log groups → select all without retention → Actions → Edit retention → set 30 / 60 / 90 days',
  });

  // ── 16. RDS Stopped Instances ──
  const rds = infraStats.rds || {};
  if (rds.stopped > 0) {
    recs.push({
      category:'Database', priority:'HIGH', icon:'🗄️',
      title:`Terminate or Restart ${rds.stopped} Stopped RDS Instance${rds.stopped>1?'s':''}`,
      description:`Stopped RDS instances still incur storage costs (~$0.115/GB/month for gp2). AWS automatically restarts them after 7 days anyway. Terminate dev/test databases not needed, or take a snapshot and delete — restore only when required.`,
      monthlySaving: rds.stopped * 15,
      action:'RDS → Databases → filter "stopped" → create snapshot → Delete instance (restore from snapshot when needed)',
    });
  }

  // ── 17. RDS GP2 → GP3 Storage ──
  if (rds.gp2Storage > 0) {
    recs.push({
      category:'Database', priority:'MEDIUM', icon:'💽',
      title:`Migrate ${rds.gp2Storage} RDS Instance${rds.gp2Storage>1?'s':''} from GP2 to GP3 Storage`,
      description:`RDS gp3 storage costs $0.115/GB vs gp2 at $0.138/GB — a 17% reduction. gp3 also allows independent IOPS and throughput scaling without over-provisioning larger volumes just for performance.`,
      monthlySaving: rds.gp2Storage * 8,
      action:'RDS → Database → Modify → Storage type: gp3 → Apply immediately',
    });
  }

  // ── 18. RDS Multi-AZ Dev/Test ──
  if (rds.multiAZ > 1) {
    recs.push({
      category:'Database', priority:'MEDIUM', icon:'🔁',
      title:`Review Multi-AZ on ${rds.multiAZ} RDS Instance${rds.multiAZ>1?'s':''}`,
      description:`Multi-AZ doubles your RDS instance cost. For dev, staging, or non-critical databases, disabling Multi-AZ cuts the DB cost in half. Keep Multi-AZ only on production instances requiring high availability.`,
      monthlySaving: rds.multiAZ * 30,
      action:'RDS → identify non-prod instances → Modify → Availability: Single-AZ → Apply',
    });
  }

  // ── 19. RDS Reserved Instances ──
  const rdsSvc2 = svc('Relational Database') || svc('RDS');
  if (rdsSvc2 && rdsSvc2.cost > 80 && rds.available > 0) {
    recs.push({
      category:'Database', priority:'HIGH', icon:'💰',
      title:'Purchase RDS Reserved Instances for Steady Production Databases',
      description:`On-demand RDS is expensive for always-on databases. 1-year Reserved Instances save 35–40%; 3-year saves up to 60%. For ${rds.available} running instance${rds.available>1?'s':''} at ~$${rdsSvc2.cost.toFixed(0)}/month, commitment-based pricing pays back in 4–6 months.`,
      monthlySaving: rdsSvc2.cost * 0.38,
      action:'RDS → Reserved instances → Purchase reserved instances → match instance type & region to running DBs',
    });
  }

  // ── 20. RDS Aurora Serverless for variable workloads ──
  if (rds.total > 0 && (rds.engines['mysql'] || rds.engines['postgres'] || rds.engines['aurora-mysql'] || rds.engines['aurora-postgresql'])) {
    recs.push({
      category:'Database', priority:'LOW', icon:'⚡',
      title:'Migrate Variable Workload Databases to Aurora Serverless v2',
      description:`Aurora Serverless v2 scales from 0.5 ACU to 128 ACU in seconds. For databases with spiky or unpredictable traffic, it eliminates over-provisioning. Costs as low as $0.12/ACU-hour, with no charge when scaled to minimum during off-hours.`,
      monthlySaving: rds.total * 20,
      action:'Evaluate query patterns in Performance Insights → create Aurora Serverless v2 cluster → migrate with DMS or snapshot restore',
    });
  }

  // Sort: HIGH first, then MEDIUM, then LOW; within each group sort by saving desc
  const pOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  recs.sort((a, b) => pOrder[a.priority] - pOrder[b.priority] || b.monthlySaving - a.monthlySaving);
  return recs;
}

// ── MASTER FETCH ──
async function fetchAllData(region, year, month) {
  const { ce, ec2, s3, sts, elb, rds } = getClients(region);
  const now = new Date();
  const billingYear  = year  || now.getFullYear();
  const billingMonth = (month !== undefined && month !== null) ? month : now.getMonth(); // 0-based

  console.log(`Fetching — region:${region} year:${billingYear} month:${billingMonth}`);

  // Selected month range
  const sel  = monthRange(billingYear, billingMonth);
  // Previous two months (always full)
  const prevMonth = billingMonth === 0
    ? monthRange(billingYear - 1, 11)
    : monthRange(billingYear, billingMonth - 1);
  prevMonth.end = fmtDate(new Date(billingYear, billingMonth, 1)); // force full prev month
  const prev2Month = billingMonth <= 1
    ? monthRange(billingYear - 1, billingMonth === 0 ? 10 : 11)
    : monthRange(billingYear, billingMonth - 2);
  prev2Month.end = fmtDate(new Date(billingYear, billingMonth - 1, 1));

  const [
    identity,
    selMap, prevMap, prev2Map,
    monthlyData,
    ec2Stats, elasticIPs, volumes, vpcStats, albStats, s3Buckets, rdsStats,
  ] = await Promise.all([
    sts.send(new GetCallerIdentityCommand({})).catch(() => ({ Account: 'N/A' })),
    ceCostByService(ce, sel.start, sel.end),
    ceCostByService(ce, prevMonth.start, prevMonth.end),
    ceCostByService(ce, prev2Month.start, prev2Month.end),
    ceMonthlyTotals(ce, billingYear),
    fetchEC2Stats(ec2),
    fetchElasticIPs(ec2),
    fetchVolumes(ec2),
    fetchVPCStats(ec2),
    fetchALBStats(elb),
    fetchS3Count(s3),
    fetchRDSStats(rds),
  ]);

  const services      = toList(selMap);
  const lastServices  = toList(prevMap);
  const twoServices   = toList(prev2Map);
  const total         = parseFloat(services.reduce((s,x) => s+x.cost, 0).toFixed(2));

  const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const billingPeriod = sel.isCurrentMonth
    ? `${MONTH_NAMES[billingMonth]} 1 – ${now.getDate()} (MTD)`
    : `${MONTH_NAMES[billingMonth]} ${billingYear} (Full Month)`;

  const infra = {
    ec2: ec2Stats, elasticIPs, volumes, s3Buckets,
    rds: rdsStats,
    vpcs: vpcStats.vpcs, subnets: vpcStats.subnets,
    natGateways: vpcStats.natGateways, internetGateways: vpcStats.internetGateways,
    securityGroups: vpcStats.securityGroups, keyPairs: vpcStats.keyPairs,
    alb: albStats,
  };

  const data = {
    accountId: identity.Account,
    billingPeriod, region, billingYear, billingMonth,
    isCurrentMonth: sel.isCurrentMonth,
    currentMonthTotal: total,
    dateRange: { start: sel.displayStart, end: sel.displayEnd },
    prevMonthRange: { start: prevMonth.start, end: prevMonth.end },
    prev2MonthRange: { start: prev2Month.start, end: prev2Month.end },
    services, lastMonthServices: lastServices, twoMonthsAgoServices: twoServices,
    monthlyData, infraStats: infra,
    fetchedAt: new Date().toISOString(),
  };

  data.recommendations = buildRecommendations(data);
  return data;
}

// ── CACHE ──
const cache = {};
const TTL   = 15 * 60 * 1000;

async function getCached(region, year, month) {
  const key = `${region}_${year}_${month}`;
  if (cache[key] && Date.now() - cache[key].ts < TTL) return cache[key].data;
  const data = await fetchAllData(region, year, month);
  cache[key] = { data, ts: Date.now() };
  return data;
}

// ── ROUTES ──
app.get('/api/billing', async (req, res) => {
  const region = req.query.region || process.env.AWS_REGION || 'us-east-1';
  const year   = parseInt(req.query.year)  || new Date().getFullYear();
  const month  = req.query.month !== undefined ? parseInt(req.query.month) : new Date().getMonth();
  try { res.json(await getCached(region, year, month)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/refresh', async (req, res) => {
  const region = req.query.region || 'us-east-1';
  const year   = parseInt(req.query.year)  || new Date().getFullYear();
  const month  = req.query.month !== undefined ? parseInt(req.query.month) : new Date().getMonth();
  const key    = `${region}_${year}_${month}`;
  delete cache[key];
  try { res.json(await getCached(region, year, month)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, HOST, () => {
  console.log(`\n✅  EagleEye — AWS Billing Intelligence → http://${HOST}:${PORT}`);
  console.log(`    Auth: IAM Role (EC2 Instance Metadata)\n`);
});
