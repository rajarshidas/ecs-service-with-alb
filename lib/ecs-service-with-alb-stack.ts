import ec2 = require("@aws-cdk/aws-ec2");
import ecs = require("@aws-cdk/aws-ecs");
import elbv2 = require("@aws-cdk/aws-elasticloadbalancingv2");
import * as cdk from "@aws-cdk/core";

export class EcsServiceWithAlbStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, "MyVpc", {
      maxAzs: 2,
      cidr: "10.101.0.0/16",
    });

    const cluster = new ecs.Cluster(this, "Ec2Cluster", { vpc });
    const clusterasg = cluster.addCapacity("DefaultASG", {
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3A,
        ec2.InstanceSize.LARGE
      ),
      keyName: "rajdast-ohio.pem",
    });

    clusterasg.addUserData(
      "rpm --import https://falco.org/repo/falcosecurity-3672BA8F.asc",
      "curl -s -o /etc/yum.repos.d/falcosecurity.repo https://falco.org/repo/falcosecurity-rpm.repo",
      "yum -y install kernel-devel-$(uname -r)",
      "yum -y install falco"
    );

    const appContainerfireLensDriverProps = {
      Name: "cloudwatch",
      region: cdk.Aws.REGION,
      log_group_name: "plasmaglass",
      log_stream_name: "appstream",
      auto_create_group: "true",
    };

    // create a task definition with CloudWatch Logs
    const logging = new ecs.FireLensLogDriver({
      options: appContainerfireLensDriverProps,
    });

    const taskDef = new ecs.Ec2TaskDefinition(this, "TDF");
    const container = taskDef.addContainer("web2", {
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      memoryLimitMiB: 512,
      logging,
    });

    container.addPortMappings({
      containerPort: 80,
      hostPort: 8080,
      protocol: ecs.Protocol.TCP,
    });

    /// Falco side-car
    const idsContainerFirelensDriverProps = {
      Name: "cloudwatch",
      region: cdk.Aws.REGION,
      log_group_name: "falco",
      log_stream_name: "alerts",
      auto_create_group: "true",
    };

    const idsLogging = new ecs.FireLensLogDriver({
      options: idsContainerFirelensDriverProps,
    });

    const idsContainerDef: ecs.ContainerDefinition = taskDef.addContainer(
      "idsContainer",
      {
        image: ecs.ContainerImage.fromRegistry("falcosecurity/falco:0.17.1"),
        cpu: 10,
        memoryLimitMiB: 512,
        privileged: true,
        command: ["/usr/bin/falco", "-pc", "-o", "json_output=true"],
        logging: idsLogging,
      }
    );

    // Volumes - start
    taskDef.addVolume({
      name: "docker-socket",
      host: {
        sourcePath: "/var/run/docker.sock",
      },
    });

    taskDef.addVolume({
      name: "dev-fs",
      host: { sourcePath: "/dev" },
    });

    taskDef.addVolume({ name: "proc-fs", host: { sourcePath: "/proc" } });

    taskDef.addVolume({ name: "boot-fs", host: { sourcePath: "/boot" } });

    taskDef.addVolume({
      name: "lib-modules",
      host: { sourcePath: "/lib/modules" },
    });

    taskDef.addVolume({
      name: "usr-fs",
      host: { sourcePath: "/usr" },
    });

    // Volumes - end
    // Mount points - start
    const dockerSocket: ecs.MountPoint = {
      containerPath: "/host/var/run/docker.sock",
      sourceVolume: "docker-socket",
      readOnly: false,
    };

    const devFs: ecs.MountPoint = {
      containerPath: "/host/dev",
      sourceVolume: "dev-fs",
      readOnly: false,
    };

    const hostProc: ecs.MountPoint = {
      containerPath: "/host/proc",
      sourceVolume: "proc-fs",
      readOnly: true,
    };

    const hostBoot: ecs.MountPoint = {
      containerPath: "/host/boot",
      sourceVolume: "boot-fs",
      readOnly: true,
    };

    const hostLibMods: ecs.MountPoint = {
      containerPath: "/host/lib/modules",
      sourceVolume: "lib-modules",
      readOnly: true,
    };

    const hostUsr: ecs.MountPoint = {
      containerPath: "/host/usr",
      sourceVolume: "usr-fs",
      readOnly: true,
    };

    idsContainerDef.addMountPoints(
      dockerSocket,
      devFs,
      hostProc,
      hostBoot,
      hostLibMods,
      hostUsr
    );

    /// End Falco side-car
    // Instantiate ECS Service with just cluster and image
    const service = new ecs.Ec2Service(this, "Ec2Service", {
      cluster,
      taskDefinition: taskDef,
    });

    // Create ALB
    const lb = new elbv2.ApplicationLoadBalancer(this, "LB", {
      vpc,
      internetFacing: true,
    });
    const listener = lb.addListener("PublicListener", { port: 80, open: true });

    // Attach ALB to ECS Service
    listener.addTargets("ECS", {
      port: 80,
      targets: [
        service.loadBalancerTarget({
          containerName: "web2",
          containerPort: 80,
        }),
      ],
      // include health check (default is none)
      healthCheck: {
        interval: cdk.Duration.seconds(60),
        path: "/health",
        timeout: cdk.Duration.seconds(5),
      },
    });
  }
}
