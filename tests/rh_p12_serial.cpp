// Exercise the same Hand implementation linked into the Mac SDK worker.
#include "../rosbridge/host-sdk/rh_p12.hpp"
#include <cassert>
#include <map>
#include <string>
using namespace rhp12;
struct FakePort {
    std::map<int,int> registers{{0,35074},{5,5<<8},{19,250},{275,120},{285,0},{287,30},{290,350},{296,241}};
    std::vector<Bytes> writes;
    std::vector<Bytes> requests;
    Bytes reply;
    std::string fault;
    void check() {}
    void write(Bytes bytes) {
        assert(crc(bytes)==0);
        requests.push_back(bytes);
        const int address=word(bytes,2);
        if(bytes[1]==3) {
            reply={1,3,uint8_t(word(bytes,4)*2)};
            for(int i=0; i<word(bytes,4); ++i) {
                int val=registers[address+i];
                reply.push_back(val>>8);reply.push_back(val&255);
            }
        } else {
            writes.push_back(bytes);
            if(bytes[1]==6) registers[address]=word(bytes,4);
            else registers[290]=word(bytes,7);
            reply.assign(bytes.begin(),bytes.begin()+6);
        }
        if(fault=="slave")reply[0]=2;
        if(fault=="function")reply[1]=4;
        if(fault=="byte_count")reply[2]=4;
        reply=frame(reply);
        if(fault=="crc") reply.back()^=1;
        if(fault=="exception") reply=frame({1,uint8_t(bytes[1]|128),2});
        if(fault=="timeout" && bytes[1]==16) reply.clear();
        if(fault=="read_timeout")reply.clear();
    }
    Bytes read(float timeout) {
        assert(timeout>0.5f && timeout<=1.0f);
        auto n=std::min<size_t>(3,reply.size());
        Bytes chunk(reply.begin(),reply.begin()+n);
        reply.erase(reply.begin(),reply.begin()+n);
        return chunk;
    }
};
int main() {
    FakePort p;
    Status s;
    Hand<FakePort> hand(p);
    hand.run(-1,false,s);
    assert(s.position==350 && s.goal_current==120 && s.voltage_tenths==241 && p.writes.empty());
    assert((p.requests.front()==Bytes{1,3,1,40,0,1,5,254}));
    hand.run(700,true,s);
    assert(s.position==700 && p.writes.size()==3);
    assert((p.writes[0]==Bytes{1,16,1,26,0,2,4,1,94,0,0,31,98}));
    assert((p.writes[1]==Bytes{1,6,1,0,0,1,73,246}));
    assert((p.writes[2]==Bytes{1,16,1,26,0,2,4,2,188,0,0,191,16}));
    for(auto fault : {"crc","exception","slave","function","byte_count","read_timeout","current_config","wrong_model","timeout"}) {
        FakePort bad;
        bad.fault=fault;
        if(bad.fault=="wrong_model") bad.registers[0]=9;
        if(bad.fault=="current_config") bad.registers[275]=300;
        Hand<FakePort> device(bad);
        try { device.run(700,true,s); assert(false); } catch(const std::runtime_error&) {}
        assert(device.attempted==(bad.fault=="timeout"));
    }
    FakePort probe;
    Hand<FakePort> diagnostic(probe);
    Status voltage;
    diagnostic.read_voltage(voltage);
    assert(voltage.voltage_tenths==241 && probe.requests.size()==1 && probe.writes.empty());
    probe.fault="crc";
    try {diagnostic.read_voltage(voltage);assert(false);}catch(const std::runtime_error&){}
    assert(voltage.voltage_tenths==-1 && !diagnostic.attempted);
}
