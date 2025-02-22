
"use strict";

// https://docs.oasis-open.org/virtio/virtio/v1.2/csd01/virtio-v1.2-csd01.html#x1-2900003

const VIRTIO_CONSOLE_DEVICE_READY     = 0;
const VIRTIO_CONSOLE_DEVICE_ADD       = 1;
const VIRTIO_CONSOLE_DEVICE_REMOVE    = 2;
const VIRTIO_CONSOLE_PORT_READY       = 3;
const VIRTIO_CONSOLE_CONSOLE_PORT     = 4;
const VIRTIO_CONSOLE_RESIZE           = 5;
const VIRTIO_CONSOLE_PORT_OPEN        = 6;
const VIRTIO_CONSOLE_PORT_NAME        = 7;

const VIRTIO_CONSOLE_F_SIZE           = 0;
const VIRTIO_CONSOLE_F_MULTIPORT      = 1;
const VIRTIO_CONSOLE_F_EMERG_WRITE    = 2;

/**
 * @constructor
 *
 * @param {CPU} cpu
 */
function VirtioConsole(cpu, bus, options)
{
    /** @const @type {BusConnector} */
    this.bus = bus;
    this.rows = 25;
    this.cols = 80;
    this.ports = 4;
    this.consolePortEnable = 0b1111; // ports 0-3 are console ports by default

    if (typeof options === 'object') {
        if (typeof options.rows === 'number') {
            this.rows = options.rows;
        }
        if (typeof options.cols === 'number') {
            this.cols = options.cols;
        }
        if (typeof options.ports === 'number') {
            this.ports = options.ports;
        }
        // ports that aren't console ports are used for binary data
        // between the guest and the host
        if (typeof options.consolePortEnable === 'number') {
            this.consolePortEnable = options.consolePortEnable;
        }
    }

    let queues = [
        {
            size_supported: 16,
            notify_offset: 0,
        },
        {
            size_supported: 16,
            notify_offset: 1,
        },
        {
            size_supported: 16,
            notify_offset: 2,
        },
        {
            size_supported: 16,
            notify_offset: 3,
        },
    ];

    for (let i = 1; i < this.ports; ++i)
    {
        queues.push({size_supported: 16, notify_offset: 0});
        queues.push({size_supported: 8, notify_offset: 1});
    }

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
    {
        name: "virtio-console",
        pci_id: 0x07 << 3,
        device_id: 0x1043,
        subsystem_device_id: 3,
        common:
        {
            initial_port: 0xB800,
            queues: queues,
            features:
            [
                VIRTIO_CONSOLE_F_SIZE,
                VIRTIO_CONSOLE_F_MULTIPORT,
                VIRTIO_F_VERSION_1,
            ],
            on_driver_ok: () => {},
        },
        notification:
        {
            initial_port: 0xB900,
            single_handler: false,
            handlers:
            [
                (queue_id) =>
                {
                    let queue = this.virtio.queues[queue_id];

                    // TODO: Full buffer looks like an empty buffer so prevent it from filling
                    while (queue.count_requests() > queue.size - 2) queue.pop_request();
                },
                (queue_id) =>
                {
                    let queue = this.virtio.queues[queue_id];
                    let port = queue_id > 3 ? (queue_id-3 >> 1) : 0;
                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);
                        this.bus.send("virtio-console" + port + "-output-bytes", buffer);
                        this.Ack(queue_id, bufchain);
                    }
                },
                (queue_id) =>
                {
                    if(queue_id != 2)
                    {
                        dbg_assert(false, "VirtioConsole Notified for wrong queue: " + queue_id +
                            " (expected queue_id of 2)");
                        return;
                    }
                    let queue = this.virtio.queues[queue_id];
                    // Full buffer looks like an empty buffer so prevent it from filling
                    while (queue.count_requests() > queue.size - 2) queue.pop_request();
                },
                (queue_id) =>
                {
                    if(queue_id != 3)
                    {
                        dbg_assert(false, "VirtioConsole Notified for wrong queue: " + queue_id +
                            " (expected queue_id of 3)");
                        return;
                    }
                    let queue = this.virtio.queues[queue_id];

                    while(queue.has_request())
                    {
                        const bufchain = queue.pop_request();
                        const buffer = new Uint8Array(bufchain.length_readable);
                        bufchain.get_next_blob(buffer);


                        let parts = marshall.Unmarshall(["w", "h", "h"], buffer, { offset : 0 });
                        let port = parts[0];
                        let event = parts[1];
                        let value = parts[2];


                        this.Ack(queue_id, bufchain);

                        switch(event) {
                            case VIRTIO_CONSOLE_DEVICE_READY:
                                for (let i = 0; i < this.ports; ++i) {
                                    this.SendEvent(i, VIRTIO_CONSOLE_DEVICE_ADD, 0);
                                }
                                break;
                            case VIRTIO_CONSOLE_PORT_READY:
                                this.Ack(queue_id, bufchain);
                                if ((1 << port) & this.consolePortEnable) {
                                    this.SendEvent(port, VIRTIO_CONSOLE_CONSOLE_PORT, 1);
                                }
                                this.SendName(port, "virtio-" + port);
                                this.SendEvent(port, VIRTIO_CONSOLE_PORT_OPEN, 1);
                                break;
                            case VIRTIO_CONSOLE_PORT_OPEN:
                                this.Ack(queue_id, bufchain);
                                if (port == 0) {
                                    this.SendWindowSize(port);
                                }
                                break;
                            default:
                                dbg_assert(false," VirtioConsole received unknown event: " + event[1]);
                                return;

                        }
                    }
                },
            ],
        },
        isr_status:
        {
            initial_port: 0xB700,
        },
        device_specific:
        {
            initial_port: 0xB600,
            struct:
            [
                {
                    bytes: 2,
                    name: "cols",
                    read: () => this.cols,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 2,
                    name: "rows",
                    read: () => this.rows,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "max_nr_ports",
                    read: () => this.ports,
                    write: data => { /* read only */ },
                },
                {
                    bytes: 4,
                    name: "emerg_wr",
                    read: () => 0,
                    write: data => {
                        dbg_assert(false, "Emergency write!");
                    },
                },
           ]
        },
    });

    for (let port = 0; port < this.ports; ++port) {
        let queue_index = port == 0 ? 0 : port * 2 + 2;
        this.bus.register("virtio-console" + port + "-input-bytes", function(data) {
            let queue = this.virtio.queues[queue_index];
            if (queue.has_request()) {
                const bufchain = queue.pop_request();
                this.Send(queue_index, bufchain, new Uint8Array(data));
            } else {
                //TODO: Buffer
            }
        }, this);

        this.bus.register("virtio-console" + port + "-resize", function(size) {
            this.cols = size[0];
            this.rows = size[1];

            if (this.virtio.queues[2].is_configured() && this.virtio.queues[2].has_request()) {
                this.SendWindowSize(port);
            }
        }, this);
    }
}

VirtioConsole.prototype.SendWindowSize = function(port)
{
    const bufchain = this.virtio.queues[2].pop_request();
    let buf = new Uint8Array(12);
    marshall.Marshall(["w", "h", "h", "h", "h"], [port, VIRTIO_CONSOLE_RESIZE, 0, this.rows, this.cols], buf, 0);
    this.Send(2, bufchain, buf);
};

VirtioConsole.prototype.SendName = function(port, name)
{
    const bufchain = this.virtio.queues[2].pop_request();
    let namex = new TextEncoder().encode(name);
    let buf = new Uint8Array(8 + namex.length + 1);
    marshall.Marshall(["w", "h", "h"], [port, VIRTIO_CONSOLE_PORT_NAME, 1], buf, 0);
    for ( let i = 0; i < namex.length; ++i ) {
        buf[i+8] = namex[i];
    }
    buf[8 + namex.length] = 0;
    this.Send(2, bufchain, buf);
};


VirtioConsole.prototype.get_state = function()
{
    let state = [];

    state[0] = this.virtio;
    state[1] = this.rows;
    state[2] = this.cols;
    state[3] = this.ports;

    return state;
};

VirtioConsole.prototype.set_state = function(state)
{
    this.virtio.set_state(state[0]);
    this.rows = state[1];
    this.cols = state[2];
    this.ports = state[3];
};

VirtioConsole.prototype.Reset = function() {

};

VirtioConsole.prototype.SendEvent = function(port, event, value)
{
    let queue = this.virtio.queues[2];
    const bufchain = queue.pop_request();

    let buf = new Uint8Array(8);
    marshall.Marshall(["w","h","h"], [port, event, value], buf, 0);
    this.Send(2, bufchain, buf);
};

VirtioConsole.prototype.Send = function (queue_id, bufchain, blob)
{
    bufchain.set_next_blob(blob);
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};

VirtioConsole.prototype.Ack = function (queue_id, bufchain)
{
    bufchain.set_next_blob(new Uint8Array(0));
    this.virtio.queues[queue_id].push_reply(bufchain);
    this.virtio.queues[queue_id].flush_replies();
};

